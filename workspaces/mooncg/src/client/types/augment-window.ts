import type { MoonCG } from "../../types/mooncg";
import type { TypedClientSocket } from "../../types/socket-protocol";
import type { MoonCGAPIClient } from "../api/api.client";

type ConstructorType = typeof MoonCGAPIClient;

declare global {
	interface Window {
		socket: TypedClientSocket;
		MoonCG: ConstructorType;
		mooncg: MoonCGAPIClient;
		__mooncg__?: boolean;
		__renderData__: {
			bundles: MoonCG.Bundle[];
			workspaces: MoonCG.Workspace[];
		};
	}

	var MoonCG: ConstructorType;
	var mooncg: MoonCGAPIClient;
	var socket: TypedClientSocket;
	var ncgConfig: MoonCG.FilteredConfig;
	var token: string;
}
