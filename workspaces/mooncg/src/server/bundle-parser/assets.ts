import type { MoonCG } from "../../types/mooncg";

export function parseAssets(
	manifest: Pick<MoonCG.Manifest, "assetCategories" | "name">,
): MoonCG.Bundle.AssetCategory[] {
	if (!manifest.assetCategories) {
		return [];
	}

	if (!Array.isArray(manifest.assetCategories)) {
		throw new Error(
			`${manifest.name}'s mooncg.assetCategories is not an Array`,
		);
	}

	return manifest.assetCategories.map((category, index) => {
		if (typeof category.name !== "string") {
			throw new Error(
				`mooncg.assetCategories[${index}] in bundle ${manifest.name} lacks a "name" property`,
			);
		}

		if (category.name.toLowerCase() === "sounds") {
			throw new Error(
				'"sounds" is a reserved assetCategory name. ' +
					`Please change mooncg.assetCategories[${index}].name in bundle ${manifest.name}`,
			);
		}

		if (typeof category.title !== "string") {
			throw new Error(
				`mooncg.assetCategories[${index}] in bundle ${manifest.name} lacks a "title" property`,
			);
		}

		if (category.allowedTypes && !Array.isArray(category.allowedTypes)) {
			throw new Error(
				`mooncg.assetCategories[${index}].allowedTypes in bundle ${manifest.name} is not an Array`,
			);
		}

		return category;
	});
}
