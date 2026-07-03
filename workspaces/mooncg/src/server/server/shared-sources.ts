import { Effect } from "effect";
import express from "express";
import path from "path";

import type { MoonCG } from "../../types/mooncg.js";
import { authCheck } from "../util/authcheck.js";
import { sendFile } from "../util/send-file/index.js";

export const sharedSourceRouter = Effect.fn("sharedSourceRouter")(function* (
	bundles: MoonCG.Bundle[],
) {
	const app = express();

	app.get("/bundles/:bundleName/shared/*", authCheck, (req, res, next) => {
		const { bundleName } = req.params;
		const bundle = bundles.find((b) => b.name === bundleName);
		if (!bundle) {
			next();
			return;
		}

		// Essentially behave like express.static
		// Serve up files with no extra logic
		const resName = req.params[0]!;
		const parentDir = path.join(bundle.dir, "shared");
		const fileLocation = path.join(parentDir, resName);
		sendFile(parentDir, fileLocation, res, next);
	});

	return app;
});
