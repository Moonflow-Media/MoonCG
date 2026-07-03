import type { DatabaseAdapter } from "@mooncg/database-adapter-types";
import express from "express";
import isError from "is-error";
import { serializeError } from "serialize-error";
import type { DeepReadonly } from "ts-essentials";

import { MoonCGAPIBase } from "../shared/api.base";
import type { MoonCG } from "../types/mooncg";
import type { RootNS } from "../types/socket-protocol";
import { config } from "./config";
import { Logger } from "./logger";
import type { Replicator } from "./replicant/replicator";
import type { ServerReplicant } from "./replicant/server-replicant";
import type { ExtensionEventMap } from "./server/extensions";
import { authCheck } from "./util/authcheck";
import { canSocketWrite } from "./util/socket-write-guard";

interface TrackedReplicantListener {
	replicant: ServerReplicant<any, any>;
	event: string;
	listener: (...args: any[]) => void;
}

const REPLICANT_ADD_LISTENER_METHODS = new Set([
	"on",
	"once",
	"addListener",
	"prependListener",
]);

const REPLICANT_REMOVE_LISTENER_METHODS = new Set(["off", "removeListener"]);

/**
 * Wraps a shared ServerReplicant in a lightweight Proxy that records all
 * listeners registered through it, so that they can be detached again when
 * the owning API instance is destroyed (e.g. on extension hot-reload).
 *
 * The Replicant itself (and thus its state) is shared and untouched — only
 * the listeners registered by this particular API instance are tracked.
 */
function createTrackedReplicant<
	V,
	O extends MoonCG.Replicant.Options<V> = MoonCG.Replicant.Options<V>,
>(
	replicant: ServerReplicant<V, O>,
	trackedListeners: TrackedReplicantListener[],
): ServerReplicant<V, O> {
	return new Proxy(replicant, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (typeof value !== "function" || typeof prop !== "string") {
				return value;
			}

			if (REPLICANT_ADD_LISTENER_METHODS.has(prop)) {
				return (event: string, listener: (...args: any[]) => void) => {
					trackedListeners.push({ replicant: target, event, listener });
					return value.call(target, event, listener);
				};
			}

			if (REPLICANT_REMOVE_LISTENER_METHODS.has(prop)) {
				return (event: string, listener: (...args: any[]) => void) => {
					const index = trackedListeners.findIndex(
						(tracked) =>
							tracked.replicant === target &&
							tracked.event === event &&
							tracked.listener === listener,
					);
					if (index >= 0) {
						trackedListeners.splice(index, 1);
					}

					return value.call(target, event, listener);
				};
			}

			return value.bind(target);
		},
		set(target, prop, newValue) {
			return Reflect.set(target, prop, newValue);
		},
	});
}

export function serverApiFactory(
	io: RootNS,
	replicator: Replicator,
	extensions: Record<string, unknown>,
	createMount: (bundle: MoonCG.Bundle) => MoonCG.Middleware,
	db: DatabaseAdapter,
) {
	const apiContexts = new Set<
		MoonCGAPIBase<"server", Record<string, any>, ExtensionEventMap>
	>();

	// A single "message" dispatcher for all API instances. Iterating over
	// `apiContexts` (instead of registering one connection handler per
	// instance) keeps the number of Socket.IO listeners constant, no matter
	// how many extensions are loaded or how often they are hot-reloaded.
	io.on("connection", (socket) => {
		socket.on("message", (data, ack) => {
			if (!canSocketWrite(db, socket, `messages:${data.bundleName}`)) {
				// The ack error is sent by the socket API middleware's
				// "message" handler; just don't invoke any extension handlers.
				return;
			}

			for (const ctx of apiContexts) {
				// One wrapped ack per context, mirroring the previous
				// per-instance connection handlers: `handled` is enforced
				// within an API instance, not across instances.
				const wrappedAck = _wrapAcknowledgement(ack);
				ctx._messageHandlers.forEach((handler) => {
					if (
						data.messageName === handler.messageName &&
						data.bundleName === handler.bundleName
					) {
						handler.func(data.content, wrappedAck);
					}
				});
			}
		});
	});

	/**
	 * This is what enables intra-context messaging.
	 * I.e., passing messages from one extension to another in the same Node.js context.
	 */
	function _forwardMessageToContext(
		messageName: string,
		bundleName: string,
		data: unknown,
	): void {
		process.nextTick(() => {
			apiContexts.forEach((ctx) => {
				ctx._messageHandlers.forEach((handler) => {
					if (
						messageName === handler.messageName &&
						bundleName === handler.bundleName
					) {
						handler.func(data);
					}
				});
			});
		});
	}

	return class MoonCGAPIServer<
		C extends Record<string, any> = MoonCG.Bundle.UnknownConfig,
	> extends MoonCGAPIBase<"server", C, ExtensionEventMap> {
		/**
		 * Tears down an API instance: removes it from the message dispatcher,
		 * removes all of its message handlers and extension lifecycle
		 * listeners, and detaches every Replicant listener that was
		 * registered through this instance. The Replicants themselves (and
		 * their state) are left untouched.
		 */
		static destroyApiInstance(instance: MoonCGAPIServer): void {
			apiContexts.delete(instance);

			for (const tracked of instance._trackedReplicantListeners) {
				tracked.replicant._emitter.removeListener(
					tracked.event,
					tracked.listener,
				);
			}

			instance._trackedReplicantListeners.length = 0;
			instance._messageHandlers.length = 0;
			instance._emitter.removeAllListeners();
		}

		static sendMessageToBundle(
			messageName: string,
			bundleName: string,
			data?: unknown,
		): void {
			_forwardMessageToContext(messageName, bundleName, data);
			io.emit("message", {
				bundleName,
				messageName,
				content: data,
			});
		}

		static readReplicant<T = unknown>(
			name: string,
			namespace: string,
		): T | undefined {
			if (!name || typeof name !== "string") {
				throw new Error("Must supply a name when reading a Replicant");
			}

			if (!namespace || typeof namespace !== "string") {
				throw new Error("Must supply a namespace when reading a Replicant");
			}

			const replicant = replicator.declare(name, namespace);
			return replicant.value as T | undefined;
		}

		static Replicant<
			V,
			O extends MoonCG.Replicant.Options<V> = MoonCG.Replicant.Options<V>,
		>(name: string, namespace: string, opts: O): ServerReplicant<V, O> {
			if (!name || typeof name !== "string") {
				throw new Error("Must supply a name when reading a Replicant");
			}

			if (!namespace || typeof namespace !== "string") {
				throw new Error("Must supply a namespace when reading a Replicant");
			}

			return replicator.declare(name, namespace, opts);
		}

		readonly Logger = Logger;

		readonly log = new Logger(this.bundleName);

		/**
		 * The full MoonCG server config, including potentially sensitive keys.
		 */
		readonly config: DeepReadonly<typeof config> = JSON.parse(
			JSON.stringify(config),
		);

		/**
		 * _Extension only_<br/>
		 * Creates a new express router.
		 * See the [express docs](http://expressjs.com/en/api.html#express.router) for usage.
		 * @function
		 */
		readonly Router = express.Router;

		util = {
			/**
			 * _Extension only_<br/>
			 * Checks if a session is authorized. Intended to be used in express routes.
			 * @param {object} req - A HTTP request.
			 * @param {object} res - A HTTP response.
			 * @param {function} next - The next middleware in the control flow.
			 */
			authCheck: authCheck,
		};

		/**
		 * _Extension only_<br/>
		 * Object containing references to all other loaded extensions. To access another bundle's extension,
		 * it _must_ be declared as a `bundleDependency` in your bundle's [`package.json`]{@tutorial manifest}.
		 * @name MoonCG#extensions
		 *
		 * @example
		 * // bundles/my-bundle/package.json
		 * {
		 *     "name": "my-bundle"
		 *     ...
		 *     "bundleDependencies": {
		 *         "other-bundle": "^1.0.0"
		 *     }
		 * }
		 *
		 * // bundles/my-bundle/extension.js
		 * module.exports = function (mooncg) {
		 *     const otherBundle = mooncg.extensions['other-bundle'];
		 *     // Now I can use `otherBundle`!
		 * }
		 */
		readonly extensions = extensions;

		/**
		 * _Extension only_<br/>
		 * Mounts Express middleware to the main server Express app.
		 * Middleware mounted using this method comes _after_ all the middlware that MoonCG
		 * uses internally.
		 * See the [Express docs](http://expressjs.com/en/api.html#app.use) for usage.
		 * @function
		 */
		mount: MoonCG.Middleware;

		/**
		 * All Replicant listeners registered through this API instance,
		 * tracked so that they can be removed on teardown.
		 */
		_trackedReplicantListeners: TrackedReplicantListener[] = [];

		/**
		 * Memoizes the tracking proxies handed out by `_replicantFactory`, so
		 * that declaring the same Replicant twice through the same API
		 * instance returns the same (proxy) reference.
		 */
		readonly _replicantProxies = new WeakMap<
			ServerReplicant<any, any>,
			ServerReplicant<any, any>
		>();

		constructor(bundle: MoonCG.Bundle) {
			super(bundle);
			this.mount = createMount(bundle);
			apiContexts.add(this);
		}

		/**
		 * _Extension only_<br/>
		 * Gets the server Socket.IO context.
		 * @function
		 */
		readonly getSocketIOServer = (): RootNS => io;

		/**
		 * Sends a message to a specific bundle. Also available as a static method.
		 * See {@link MoonCG#sendMessage} for usage details.
		 * @param {string} messageName - The name of the message.
		 * @param {string} bundleName - The name of the target bundle.
		 * @param {mixed} [data] - The data to send.
		 * @param {function} [cb] - _Browser only_ The error-first callback to handle the server's
		 * [acknowledgement](http://socket.io/docs/#sending-and-getting-data-%28acknowledgements%29) message, if any.
		 * @return {Promise|undefined} - _Browser only_ A Promise that is rejected if the first argument provided to the
		 * acknowledgement is an `Error`, otherwise it is resolved with the remaining arguments provided to the acknowledgement.
		 * But, if a callback was provided, this return value will be `undefined`, and there will be no Promise.
		 */
		sendMessageToBundle(
			messageName: string,
			bundleName: string,
			data?: unknown,
		): void {
			this.log.trace(
				"Sending message %s to bundle %s with data:",
				messageName,
				bundleName,
				data,
			);

			return MoonCGAPIServer.sendMessageToBundle.apply(
				MoonCGAPIBase,
				arguments as any, // eslint-disable-line prefer-rest-params
			);
		}

		/**
		 * Sends a message with optional data within the current bundle.
		 * Messages can be sent from client to server, server to client, or client to client.
		 *
		 * Messages are namespaced by bundle. To send a message in another bundle's namespace,
		 * use {@link MoonCG#sendMessageToBundle}.
		 *
		 * When a `sendMessage` is used from a client context (i.e., graphic or dashboard panel),
		 * it returns a `Promise` called an "acknowledgement". Your server-side code (i.e., extension)
		 * can invoke this acknowledgement with whatever data (or error) it wants. Errors sent to acknowledgements
		 * from the server will be properly serialized and intact when received on the client.
		 *
		 * Alternatively, if you do not wish to use a `Promise`, you can provide a standard error-first
		 * callback as the last argument to `sendMessage`.
		 *
		 * If your server-side code has multiple listenFor handlers for your message,
		 * you must first check if the acknowledgement has already been handled before
		 * attempting to call it. You may so do by checking the `.handled` boolean
		 * property of the `ack` function passed to your listenFor handler.
		 *
		 * See [Socket.IO's docs](http://socket.io/docs/#sending-and-getting-data-%28acknowledgements%29)
		 * for more information on how acknowledgements work under the hood.
		 *
		 * @param {string} messageName - The name of the message.
		 * @param {mixed} [data] - The data to send.
		 * @param {function} [cb] - _Browser only_ The error-first callback to handle the server's
		 * [acknowledgement](http://socket.io/docs/#sending-and-getting-data-%28acknowledgements%29) message, if any.
		 * @return {Promise} - _Browser only_ A Promise that is rejected if the first argument provided to the
		 * acknowledgement is an `Error`, otherwise it is resolved with the remaining arguments provided to the acknowledgement.
		 *
		 * @example <caption>Sending a normal message:</caption>
		 * mooncg.sendMessage('printMessage', 'dope.');
		 *
		 * @example <caption>Sending a message and replying with an acknowledgement:</caption>
		 * // bundles/my-bundle/extension.js
		 * module.exports = function (mooncg) {
		 *     mooncg.listenFor('multiplyByTwo', (value, ack) => {
		 *         if (value === 4) {
		 *             ack(new Error('I don\'t like multiplying the number 4!');
		 *             return;
		 *         }
		 *
		 *         // acknowledgements should always be error-first callbacks.
		 *         // If you do not wish to send an error, send "null"
		 *         if (ack && !ack.handled) {
		 *             ack(null, value * 2);
		 *         }
		 *     });
		 * }
		 *
		 * // bundles/my-bundle/graphics/script.js
		 * // Both of these examples are functionally identical.
		 *
		 * // Promise acknowledgement
		 * mooncg.sendMessage('multiplyByTwo', 2)
		 *     .then(result => {
		 *         console.log(result); // Will eventually print '4'
		 *     .catch(error => {
		 *         console.error(error);
		 *     });
		 *
		 * // Error-first callback acknowledgement
		 * mooncg.sendMessage('multiplyByTwo', 2, (error, result) => {
		 *     if (error) {
		 *         console.error(error);
		 *         return;
		 *     }
		 *
		 *     console.log(result); // Will eventually print '4'
		 * });
		 */
		sendMessage(messageName: string, data?: unknown): void {
			this.sendMessageToBundle(messageName, this.bundleName, data);
		}

		/**
		 * Reads the value of a replicant once, and doesn't create a subscription to it. Also available as a static method.
		 * @param {string} name - The name of the replicant.
		 * @param {string} [bundle=CURR_BNDL] - The bundle namespace to in which to look for this replicant.
		 * @param {function} cb - _Browser only_ The callback that handles the server's response which contains the value.
		 * @example <caption>From an extension:</caption>
		 * // Extensions have immediate access to the database of Replicants.
		 * // For this reason, they can use readReplicant synchronously, without a callback.
		 * module.exports = function (mooncg) {
		 *     var myVal = mooncg.readReplicant('myVar', 'some-bundle');
		 * }
		 * @example <caption>From a graphic or dashboard panel:</caption>
		 * // Graphics and dashboard panels must query the server to retrieve the value,
		 * // and therefore must provide a callback.
		 * mooncg.readReplicant('myRep', 'some-bundle', value => {
		 *     // I can use 'value' now!
		 *     console.log('myRep has the value '+ value +'!');
		 * });
		 */
		readReplicant<T = unknown>(
			name: string,
			param2?: string | MoonCG.Bundle,
		): T | undefined {
			let { bundleName } = this;
			if (typeof param2 === "string") {
				bundleName = param2;
			} else if (typeof param2 === "object" && bundleName in param2) {
				bundleName = param2.name;
			}

			return (this.constructor as any).readReplicant(name, bundleName);
		}

		_replicantFactory = <
			V,
			O extends MoonCG.Replicant.Options<V> = MoonCG.Replicant.Options<V>,
		>(
			name: string,
			namespace: string,
			opts: O,
		): ServerReplicant<V, O> => {
			const replicant = replicator.declare<V, O>(name, namespace, opts);
			const memoized = this._replicantProxies.get(replicant);
			if (memoized) {
				return memoized;
			}

			const proxy = createTrackedReplicant(
				replicant,
				this._trackedReplicantListeners,
			);
			this._replicantProxies.set(replicant, proxy);
			return proxy;
		};
	};
}

/**
 * By default, Errors get serialized to empty objects when run through JSON.stringify.
 * This function wraps an "acknowledgement" callback and checks if the first argument
 * is an Error. If it is, that Error is serialized _before_ being sent off to Socket.IO
 * for serialization to be sent across the wire.
 * @param ack {Function}
 * @private
 * @ignore
 * @returns {Function}
 */
function _wrapAcknowledgement(
	ack: (err?: any, response?: unknown) => void,
): MoonCG.Acknowledgement {
	let handled = false;
	const wrappedAck = function (firstArg: any, ...restArgs: any[]): void {
		if (handled) {
			throw new Error("Acknowledgement already handled");
		}

		handled = true;
		if (isError(firstArg)) {
			firstArg = serializeError(firstArg);
		}

		ack(firstArg, ...restArgs);
	};

	Object.defineProperty(wrappedAck, "handled", {
		get() {
			return handled;
		},
	});

	return wrappedAck as MoonCG.Acknowledgement;
}
