import { MoonCGAPIClient } from "../../../../dist/dts/client/api/api.client";

type BundleConfig = { foo: { bar: "bar" } };

declare global {
	var MoonCG: typeof MoonCGAPIClient;
	var mooncg: MoonCGAPIClient<BundleConfig>;
}
