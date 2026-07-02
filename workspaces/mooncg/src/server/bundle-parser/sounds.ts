import * as fs from "fs";
import * as path from "path";

import type { MoonCG } from "../../types/mooncg";

export function parseSounds(
	bundlePath: string,
	manifest: Pick<MoonCG.Manifest, "soundCues" | "name">,
): { soundCues: MoonCG.Bundle.SoundCue[]; hasAssignableSoundCues: boolean } {
	if (!manifest.soundCues) {
		return { soundCues: [], hasAssignableSoundCues: false };
	}

	if (!Array.isArray(manifest.soundCues)) {
		throw new Error(`${manifest.name}'s mooncg.soundCues is not an Array`);
	}

	let hasAssignable = false;
	const parsedCues = manifest.soundCues.map((unparsedCue, index) => {
		if (typeof unparsedCue.name !== "string") {
			throw new Error(
				`mooncg.soundCues[${index}] in bundle ${manifest.name} lacks a "name" property`,
			);
		}

		const parsedCue = {
			...unparsedCue,
		};

		if (typeof parsedCue.assignable === "undefined") {
			parsedCue.assignable = true;
		}

		if (parsedCue.assignable) {
			hasAssignable = true;
		}

		// Clamp default volume to 0-100.
		if (parsedCue.defaultVolume) {
			parsedCue.defaultVolume = Math.min(parsedCue.defaultVolume, 100);
			parsedCue.defaultVolume = Math.max(parsedCue.defaultVolume, 0);
		}

		// Verify that defaultFile exists, if provided.
		if (parsedCue.defaultFile) {
			const defaultFilePath = path.join(bundlePath, parsedCue.defaultFile);
			if (!fs.existsSync(defaultFilePath)) {
				throw new Error(
					`mooncg.soundCues[${index}].defaultFile in bundle ${manifest.name} does not exist`,
				);
			}
		}

		return parsedCue;
	});

	return { soundCues: parsedCues, hasAssignableSoundCues: hasAssignable };
}
