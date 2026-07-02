import { Effect } from "effect";

import { recursivelyFindPackageJson } from "../util/mooncg-package-json.js";

export class MooncgVersion extends Effect.Service<MooncgVersion>()(
	"MooncgVersion",
	{
		sync: () => {
			const packageJson = recursivelyFindPackageJson();
			return {
				version: packageJson.version,
			};
		},
	},
) {}
