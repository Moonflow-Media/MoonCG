import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";

export function sha1(input: string | Buffer) {
	return createHash("sha1").update(input).digest("hex");
}

export async function sha1File(filePath: string) {
	const hash = createHash("sha1");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

export function sha1FileSync(filePath: string) {
	return sha1(readFileSync(filePath));
}
