// Minimal imports for first setup
import "./sentry-config.js";

import * as Sentry from "@sentry/node";
import * as os from "os";

import { config, filteredConfig, sentryEnabled } from "../config/index.js";
import { mooncgPackageJson } from "../util/mooncg-package-json.js";
import * as login from "./login/index.js";

if (config.sentry?.enabled) {
	Sentry.init({
		dsn: config.sentry.dsn,
		serverName: os.hostname(),
		release: mooncgPackageJson.version,
	});
	Sentry.configureScope((scope) => {
		scope.setTags({
			mooncgHost: config.host,
			mooncgBaseURL: config.baseURL,
		});
	});

	process.on("unhandledRejection", (reason, p) => {
		console.error("Unhandled Rejection at:", p, "reason:", reason);
		Sentry.captureException(reason);
	});

	console.info("[mooncg] Sentry enabled.");
}

import fs = require("fs");
import path = require("path");

import { databaseAdapter as defaultAdapter } from "@mooncg/database-adapter-sqlite-legacy";
import { rootPaths } from "@mooncg/internal-util";
import bodyParser from "body-parser";
import compression from "compression";
import { Data, Deferred, Effect, Fiber, PubSub, Runtime, Stream } from "effect";
import express from "express";
import transformMiddleware from "express-transform-bare-module-specifiers";
import memoize from "fast-memoize";
import type { Server } from "http";
import { klona as clone } from "klona/json";
import { template } from "lodash";
import passport from "passport";
import * as SocketIO from "socket.io";

import type {
	ClientToServerEvents,
	ServerToClientEvents,
} from "../../types/socket-protocol.js";
import { UnknownError } from "../_effect/boundary.js";
import { listenToEvent, waitForEvent } from "../_effect/event-listener.js";
import { createLogger } from "../logger/index.js";
import { Replicator } from "../replicant/replicator.js";
import { authCheck } from "../util/authcheck.js";
import { assetsRouter } from "./assets.js";
import { createAuthApiRouter } from "./auth-api/index.js";
import { BundleService, makeBundleService } from "./bundle-service.js";
import { dashboardRouter } from "./dashboard.js";
import { createExtensionManager } from "./extensions.js";
import { graphicsRouter } from "./graphics/index.js";
import { createSocketAuthMiddleware } from "./login/socketAuthMiddleware.js";
import { mountsRouter } from "./mounts.js";
import { sentryConfigRouter } from "./sentry-config.js";
import { sharedSourceRouter } from "./shared-sources.js";
import { createSocketApiMiddleware } from "./socketApiMiddleware.js";
import { soundsRouter } from "./sounds.js";

const renderTemplate = memoize((content, options) =>
	template(content)(options),
);

const log = createLogger("server");

export const createServer = Effect.fn("createServer")(function* (
	isReady?: Deferred.Deferred<void>,
) {
	const app = express();

	/**
	 * HTTP(S) server setup
	 */
	const server = yield* Effect.promise(async (): Promise<Server> => {
		if (
			config.ssl.enabled &&
			config.ssl.keyPath &&
			config.ssl.certificatePath
		) {
			const sslOpts: { key: Buffer; cert: Buffer; passphrase?: string } = {
				key: fs.readFileSync(config.ssl.keyPath),
				cert: fs.readFileSync(config.ssl.certificatePath),
			};
			if (config.ssl.passphrase) {
				sslOpts.passphrase = config.ssl.passphrase;
			}

			// If we allow HTTP on the same port, use httpolyglot
			// otherwise, standard https server
			if (config.ssl.allowHTTP) {
				// TODO: Remove this
				const { createServer } = await import("httpolyglot");
				return createServer(sslOpts, app);
			} else {
				const { createServer } = await import("https");
				return createServer(sslOpts, app);
			}
		} else {
			const { createServer } = await import("http");
			return createServer(app);
		}
	});

	// Fork to immediately start listening for events
	// With scope so that it's cleaned up when the server is closed
	const waitForError = yield* Effect.forkScoped(
		waitForEvent<[unknown]>(server, "error").pipe(
			Effect.andThen(([err]) => Effect.fail(new UnknownError(err))),
		),
	);
	const waitForClose = yield* Effect.forkScoped(
		waitForEvent<[]>(server, "close"),
	);

	const io = yield* Effect.acquireRelease(
		Effect.sync(
			() =>
				new SocketIO.Server<ClientToServerEvents, ServerToClientEvents>(server),
		),
		(io) =>
			Effect.promise(async () => {
				io.disconnectSockets(true);
				await io.close();
			}),
	).pipe(Effect.map((io) => io.of("/")));

	log.info(
		`Starting MoonCG ${mooncgPackageJson.version} (Running on Node.js ${process.version})`,
	);

	if (sentryEnabled) {
		app.use(Sentry.Handlers.requestHandler());
	}

	// Set up Express
	app.use(compression());
	app.use(
		bodyParser.json({
			// The verify callback receives the raw request object (IncomingMessage)
			// before body-parser processes it. We use 'any' here because we're
			// augmenting it with a property that will be available on Express.Request.
			verify: (req: any, _res, buf) => {
				req.rawBody = buf;
			},
		}),
	);
	app.use(
		bodyParser.urlencoded({
			extended: true,
			verify: (req: any, _res, buf) => {
				req.rawBody = buf;
			},
		}),
	);

	app.set("trust proxy", true);

	app.engine("tmpl", (filePath: string, options: any, callback: any) => {
		fs.readFile(filePath, (error, content) => {
			if (error) {
				return callback(error);
			}

			return callback(null, renderTemplate(content, options));
		});
	});

	const bundlesPaths = [
		path.join(rootPaths.getRuntimeRoot(), "bundles"),
	].concat(config.bundles?.paths ?? []);
	const cfgPath = path.join(rootPaths.getRuntimeRoot(), "cfg");
	const bundleService = BundleService.make(
		yield* makeBundleService({
			bundlesPaths,
			cfgPath,
			mooncgVersion: mooncgPackageJson.version,
			mooncgConfig: config,
		}),
	);

	let databaseAdapter = defaultAdapter;
	let databaseAdapterExists = false;
	for (const bundle of yield* bundleService.all()) {
		if (bundle.mooncgBundleConfig.databaseAdapter) {
			log.warn(
				"`databaseAdapter` is an experimental feature and may be changed without major version bump.",
			);
			if (databaseAdapterExists) {
				throw new Error(
					"Multiple bundles are attempting to set the database adapter.",
				);
			}
			databaseAdapter = bundle.mooncgBundleConfig.databaseAdapter;
			databaseAdapterExists = true;
		}
	}

	app.use((_, res, next) => {
		res.locals.databaseAdapter = databaseAdapter;
		next();
	});

	if (config.login?.enabled) {
		log.info("Login security enabled");
		const { app: loginMiddleware, sessionMiddleware } = login.createMiddleware(
			databaseAdapter,
			{
				onLogin: (user) => {
					// If the user had no roles, then that means they "logged in"
					// with a third-party auth provider but weren't able to
					// get past the login page because the MoonCG config didn't allow that user.
					// At this time, we only tell extensions about users that are valid.
					if (user.roles.length > 0) {
						extensionManager.emitToAllInstances("login", user);
					}
				},
				onLogout: (user) => {
					if (user.roles.length > 0) {
						extensionManager.emitToAllInstances("logout", user);
					}
				},
			},
		);
		app.use(loginMiddleware);

		// convert a connect middleware to a Socket.IO middleware
		const wrap = (middleware: any) => (socket: SocketIO.Socket, next: any) =>
			middleware(socket.request, {}, next);

		io.use(wrap(sessionMiddleware));
		io.use(wrap(passport.initialize()));
		io.use(wrap(passport.session()));

		io.use(createSocketAuthMiddleware(databaseAdapter));
	} else {
		app.get("/login*", (_, res) => {
			res.redirect("/dashboard");
		});
	}

	io.use(createSocketApiMiddleware(databaseAdapter));

	// REST API for user management, 2FA and session management.
	app.use("/api/v1", authCheck, createAuthApiRouter(databaseAdapter, io));

	// Wait for Chokidar to finish its initial scan.
	yield* bundleService.awaitReady.pipe(
		Effect.timeoutFail({
			duration: "15 seconds",
			onTimeout: () => new FileWatcherReadyTimeoutError(),
		}),
	);

	for (const bundle of yield* bundleService.all()) {
		// TODO: remove this feature in v3
		if (bundle.transformBareModuleSpecifiers) {
			log.warn(
				`${bundle.name} uses the deprecated "transformBareModuleSpecifiers" feature. ` +
					"This feature will be removed in MoonCG v3. " +
					"Please migrate to using browser-native import maps instead: " +
					"https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap",
			);
			const opts = {
				rootDir: rootPaths.getRuntimeRoot(),
				modulesUrl: `/bundles/${bundle.name}/node_modules`,
			};
			app.use(`/bundles/${bundle.name}/*`, transformMiddleware(opts));
		}
	}

	log.trace(`Attempting to listen on ${config.host}:${config.port}`);

	yield* Effect.forkScoped(
		listenToEvent<[Error]>(server, "error").pipe(
			Effect.andThen(
				Stream.runForEach(([err]) =>
					Effect.sync(() => {
						if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
							// There is a separate handling in MOONCG_TEST
							if (!process.env.MOONCG_TEST) {
								log.error(
									`Listen ${config.host}:${config.port} in use, is MoonCG already running? MoonCG will now exit.`,
								);
							}
						} else {
							log.error("Unhandled error!", err);
						}
					}),
				),
			),
		),
	);

	if (sentryEnabled) {
		const sentryApp = yield* sentryConfigRouter(bundleService);
		app.use(sentryApp);
	}

	const persistedReplicantEntities = yield* Effect.promise(async () => {
		const replicants = await databaseAdapter.getAllReplicants();
		return replicants;
	});

	const replicator = yield* Effect.acquireRelease(
		Effect.sync(
			() => new Replicator(io, databaseAdapter, persistedReplicantEntities),
		),
		(replicator) => Effect.sync(() => replicator.saveAllReplicants()),
	);

	const graphicsRoute = yield* graphicsRouter(io, bundleService, replicator);
	app.use(graphicsRoute);

	const dashboardRoute = yield* dashboardRouter(bundleService);
	app.use(dashboardRoute);

	const mounts = yield* mountsRouter(yield* bundleService.all());
	app.use(mounts);

	const sounds = yield* soundsRouter(yield* bundleService.all(), replicator);
	app.use(sounds);

	const assets = yield* assetsRouter(yield* bundleService.all(), replicator);
	app.use("/assets", assets);

	const sharedSources = yield* sharedSourceRouter(yield* bundleService.all());
	app.use(sharedSources);

	if (sentryEnabled) {
		app.use(Sentry.Handlers.errorHandler());
	}

	// Fallthrough error handler,
	// Taken from https://docs.sentry.io/platforms/node/express/
	app.use(
		(
			err: unknown,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			res.statusCode = 500;
			if (sentryEnabled) {
				// The error id is attached to `res.sentry` to be returned
				// and optionally displayed to the user for support.
				res.end(
					`Internal error\nSentry issue ID: ${String((res as any).sentry)}\n`,
				);
			} else {
				res.end("Internal error");
			}

			log.error(err);
		},
	);

	// Set up "bundles" Replicant.
	const bundlesReplicant = replicator.declare("bundles", "mooncg", {
		schemaPath: path.join(
			rootPaths.mooncgInstalledPath,
			"schemas/bundles.json",
		),
		persistent: false,
	});
	const updateBundlesReplicant = Effect.fn(function* () {
		const bundles = yield* bundleService.all();
		bundlesReplicant.value = clone(bundles);
	});
	// Subscribe eagerly so that no events published between here and the
	// forked fiber's startup are missed.
	const bundleEventsSubscription = yield* PubSub.subscribe(
		bundleService.subscribe,
	);
	yield* Effect.forkScoped(
		Stream.fromQueue(bundleEventsSubscription).pipe(
			Stream.filter((event) => event._tag !== "InvalidBundle"),
			Stream.debounce("100 millis"),
			Stream.runForEach(updateBundlesReplicant),
		),
	);
	yield* updateBundlesReplicant();

	// Client hot-reload: tell open dashboards (and, if enabled, graphics) to
	// refresh a bundle's views when the bundle changes. Debounced per bundle.
	if (config.hotReload.dashboard || config.hotReload.graphics) {
		const clientRefreshFibers = new Map<string, Fiber.RuntimeFiber<void>>();
		const runClientRefresh = Effect.fn("runClientRefresh")(function* (
			bundleName: string,
		) {
			yield* Effect.sleep("500 millis");
			yield* Effect.sync(() => {
				clientRefreshFibers.delete(bundleName);
				if (config.hotReload.dashboard) {
					io.emit("dashboard:bundleRefresh", bundleName);
				}

				if (config.hotReload.graphics) {
					io.emit("graphic:bundleRefresh", bundleName);
				}
			});
		});
		const scheduleClientRefresh = Effect.fn("scheduleClientRefresh")(function* (
			bundleName: string,
		) {
			const pending = clientRefreshFibers.get(bundleName);
			if (pending) {
				yield* Fiber.interrupt(pending);
			}

			const fiber = yield* Effect.forkScoped(runClientRefresh(bundleName));
			yield* Effect.sync(() => clientRefreshFibers.set(bundleName, fiber));
		});
		// Subscribe eagerly so that no events published between here and the
		// forked fiber's startup are missed.
		const clientRefreshSubscription = yield* PubSub.subscribe(
			bundleService.subscribe,
		);
		yield* Effect.forkScoped(
			Stream.fromQueue(clientRefreshSubscription).pipe(
				Stream.runForEach((event) =>
					event._tag === "BundleChanged"
						? scheduleClientRefresh(event.bundle.name)
						: Effect.void,
				),
			),
		);
	}

	const mount = (...args: any[]) => app.use(...args);
	const extensionManager = yield* Effect.acquireRelease(
		createExtensionManager(
			io,
			bundleService,
			replicator,
			mount,
			databaseAdapter,
		),
		(extensionManager) =>
			Effect.sync(() => extensionManager.emitToAllInstances("serverStopping")),
	);
	extensionManager.emitToAllInstances("extensionsLoaded");

	// Extension hot-reload: reload a bundle's extension when its code changes
	// on disk. Subscribe eagerly so that no events published between here and
	// the forked fiber's startup are missed.
	const extensionEventsSubscription = yield* PubSub.subscribe(
		bundleService.subscribe,
	);
	yield* Effect.forkScoped(
		Stream.fromQueue(extensionEventsSubscription).pipe(
			Stream.runForEach((event) =>
				event._tag === "ExtensionChanged"
					? extensionManager.reloadExtension(event.bundle.name)
					: Effect.void,
			),
		),
	);

	const runtime = yield* Effect.runtime();

	const run = Effect.fn(function* () {
		server.listen(
			{
				host: config.host,
				port: process.env.MOONCG_TEST ? undefined : config.port,
			},
			() =>
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						if (process.env.MOONCG_TEST) {
							const addrInfo = server.address();
							if (typeof addrInfo !== "object" || addrInfo === null) {
								throw new Error("couldn't get port number");
							}

							const { port } = addrInfo;
							log.warn(
								`Test mode active, using automatic listen port: ${port}`,
							);
							config.port = port;
							filteredConfig.port = port;
							process.env.MOONCG_TEST_PORT = String(port);
						}

						const protocol = config.ssl?.enabled ? "https" : "http";
						log.info("MoonCG running on %s://%s", protocol, config.baseURL);
						if (isReady) {
							yield* Deferred.succeed(isReady, undefined);
						}
						extensionManager.emitToAllInstances("serverStarted");
					}),
				),
		);
		return yield* Effect.raceFirst(waitForError, waitForClose);
	});

	return {
		run,
		getExtensions: () => extensionManager.getExtensions(),
		saveAllReplicantsNow: () => replicator.saveAllReplicantsNow(),
		bundleService,
	};
});

export class FileWatcherReadyTimeoutError extends Data.TaggedError(
	"FileWatcherReadyTimeoutError",
) {
	override readonly message = "Timed out waiting for file watcher to be ready";
}
