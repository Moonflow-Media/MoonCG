import * as path from "node:path";

import { isLegacyProject } from "@mooncg/internal-util";
import * as IOE from "fp-ts/IOEither";
import semver from "semver";

import type { MoonCG } from "../../types/mooncg";

export const parseManifest =
	(bundlePath: string) => (packageJson: MoonCG.PackageJSON) => {
		if (!packageJson.name) {
			return IOE.left(
				new Error(`${bundlePath}'s package.json must specify "name".`),
			);
		}

		if (isLegacyProject()) {
			if (!packageJson.mooncg) {
				return IOE.left(
					new Error(
						`${packageJson.name}'s package.json lacks a "mooncg" property, and therefore cannot be parsed.`,
					),
				);
			}
			if (!semver.validRange(packageJson.mooncg.compatibleRange)) {
				return IOE.left(
					new Error(
						`${packageJson.name}'s package.json does not have a valid "mooncg.compatibleRange" property.`,
					),
				);
			}
			const bundleFolderName = path.basename(bundlePath);
			if (bundleFolderName !== packageJson.name) {
				return IOE.left(
					new Error(
						`${packageJson.name}'s folder is named "${bundleFolderName}". Please rename it to "${packageJson.name}".`,
					),
				);
			}
		}

		return IOE.right({
			...packageJson.mooncg,
			name: packageJson.name,
			version: packageJson.version,
			license: packageJson.license,
			description: packageJson.description,
			homepage: packageJson.homepage,
			author: packageJson.author,
			contributors: packageJson.contributors,
			transformBareModuleSpecifiers: Boolean(
				packageJson.mooncg?.transformBareModuleSpecifiers,
			),
		} satisfies MoonCG.Manifest);
	};
