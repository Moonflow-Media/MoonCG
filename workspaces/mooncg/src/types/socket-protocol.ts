import type { User } from "@mooncg/database-adapter-types";
import type {
	DefaultEventsMap,
	Namespace,
	Server,
	Socket as ServerSocket,
} from "socket.io";
import type { Socket as ClientSocket } from "socket.io-client";

import type { MoonCG } from "./mooncg";

interface NodeCallback<T = undefined> {
	(err: string, response: undefined): void;
	(err: undefined, response: T): void;
}

export enum UnAuthErrCode {
	CredentialsBadFormat = "credentials_bad_format",
	CredentialsRequired = "credentials_required",
	InternalError = "internal_error",
	InvalidToken = "invalid_token",
	TokenRevoked = "token_invalidated",
	InvalidSession = "invalid_session",
}

export interface ProtocolError {
	message: string;
	code: UnAuthErrCode;
	type: string;
}

export interface GraphicRegRequest {
	timestamp: number;
	pathName: string;
	bundleName: string;
	bundleVersion?: string;
	bundleGit: MoonCG.Bundle.GitData;
}

export interface ServerToClientEvents {
	protocol_error: (error: ProtocolError) => void;
	"graphic:bundleRefresh": (bundleName: string) => void;
	"graphic:refreshAll": (graphic: MoonCG.Bundle.Graphic) => void;
	"graphic:refresh": (graphicInstance: MoonCG.GraphicsInstance) => void;
	"graphic:kill": (graphicInstance: MoonCG.GraphicsInstance) => void;
	"replicant:operations": (data: {
		name: string;
		namespace: string;
		revision: number;
		operations: MoonCG.Replicant.Operation<any>[];
	}) => void;
	message: (data: {
		messageName: string;
		bundleName: string;
		content: unknown;
	}) => void;
}

export interface ClientToServerEvents {
	regenerateToken: (callback: NodeCallback) => Promise<void>;
	"graphic:registerSocket": (
		request: GraphicRegRequest,
		callback: NodeCallback<boolean>,
	) => void;
	"graphic:queryAvailability": (
		request: string,
		callback: NodeCallback<boolean>,
	) => void;
	"graphic:requestBundleRefresh": (
		request: string,
		callback: NodeCallback,
	) => void;
	"graphic:requestRefreshAll": (
		request: MoonCG.Bundle.Graphic,
		callback: NodeCallback,
	) => void;
	"graphic:requestRefresh": (
		request: MoonCG.GraphicsInstance,
		callback: NodeCallback,
	) => void;
	"graphic:requestKill": (
		request: MoonCG.GraphicsInstance,
		callback: NodeCallback,
	) => void;
	"replicant:declare": (
		request: {
			name: string;
			namespace: string;
			opts: MoonCG.Replicant.Options<any>;
		},
		callback: NodeCallback<
			| {
					value: any;
					revision: number;
			  }
			| {
					value: any;
					revision: number;
					schema: Record<string, any>;
					schemaSum: string;
			  }
		>,
	) => void;
	"replicant:proposeOperations": (
		request:
			| {
					name: string;
					namespace: string;
					operations: MoonCG.Replicant.Operation<any>[];
					opts: MoonCG.Replicant.Options<any>;
					revision: number;
			  }
			| {
					name: string;
					namespace: string;
					operations: MoonCG.Replicant.Operation<any>[];
					opts: MoonCG.Replicant.Options<any>;
					revision: number;
					schema: Record<string, any>;
					schemaSum: string;
			  },
		callback: (
			rejectReason: string | undefined,
			data: {
				value: any;
				revision: number;
				schema?: Record<string, any>;
				schemaSum?: string;
			},
		) => void,
	) => void;
	"replicant:read": (
		request: {
			name: string;
			namespace: string;
		},
		callback: NodeCallback<unknown>,
	) => void;
	message: (
		request: {
			messageName: string;
			bundleName: string;
			content: unknown;
		},
		callback: NodeCallback<unknown>,
	) => void;
	joinRoom: (request: string, callback: NodeCallback) => void;
}

/**
 * Per-socket server-side state, populated by the socket auth middleware.
 */
export interface SocketData {
	/**
	 * The authenticated user this socket belongs to.
	 * Only set when login security is enabled.
	 */
	user?: User;

	/**
	 * The express-session id of the handshake request (if any).
	 * Used to disconnect sockets when their session is terminated.
	 */
	sessionId?: string;
}

export type TypedClientSocket = ClientSocket<
	ServerToClientEvents,
	ClientToServerEvents
>;
export type TypedSocketServer = Server<
	ClientToServerEvents,
	ServerToClientEvents,
	DefaultEventsMap,
	SocketData
>;
export type RootNS = Namespace<
	ClientToServerEvents,
	ServerToClientEvents,
	DefaultEventsMap,
	SocketData
>;
export type TypedServerSocket = ServerSocket<
	ClientToServerEvents,
	ServerToClientEvents,
	DefaultEventsMap,
	SocketData
>;
