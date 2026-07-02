import { MoonCGAPIClient } from "../dist/dts/client/api/api.client";

declare global {
	var MoonCG: typeof MoonCGAPIClient;
	var mooncg: MoonCGAPIClient;
}
