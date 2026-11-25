import { createClient } from '@mooncg/sdk/client';

// The page is served below /b/{{name}}/ by MoonCG and by the development server alike, so the
// client learns the bundle, and on a graphic which graphic it is, from the page's address.
// In OBS, add a graphic as a browser source with an API token: ...?token=mcg_...
export const mc = createClient();
