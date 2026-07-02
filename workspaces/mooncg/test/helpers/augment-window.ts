import "../../src/client/types/augment-window";

import type { MoonCGAPIClient } from "../../src/client/api/api.client";

declare global {
	interface Window {
		dashboardApi: MoonCGAPIClient;
		graphicApi: MoonCGAPIClient;
		singleInstanceApi: MoonCGAPIClient;
	}
}
