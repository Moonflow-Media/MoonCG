import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

const PARAMS_PATTERN = /^N=(\d+),r=(\d+),p=(\d+)$/;

/**
 * Hashes a password with scrypt (node:crypto, no native add-on required).
 *
 * Format: `scrypt$N=16384,r=8,p=1$<salt-b64>$<hash-b64>`
 */
export function hashPassword(password: string): string {
	const salt = randomBytes(SALT_LENGTH);
	const key = scryptSync(password, salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	});
	return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString(
		"base64",
	)}$${key.toString("base64")}`;
}

/**
 * Verifies a password against a stored hash in the format produced by
 * {@link hashPassword}. Uses `timingSafeEqual` for the comparison.
 * Returns false for malformed hashes instead of throwing.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
	const [scheme, params, saltB64, hashB64, ...rest] = storedHash.split("$");
	if (scheme !== "scrypt" || !params || !saltB64 || !hashB64 || rest.length > 0) {
		return false;
	}

	const paramsMatch = PARAMS_PATTERN.exec(params);
	if (!paramsMatch) {
		return false;
	}

	const cost = Number(paramsMatch[1]);
	const blockSize = Number(paramsMatch[2]);
	const parallelization = Number(paramsMatch[3]);

	const salt = Buffer.from(saltB64, "base64");
	const expected = Buffer.from(hashB64, "base64");
	if (salt.length === 0 || expected.length === 0) {
		return false;
	}

	try {
		const actual = scryptSync(password, salt, expected.length, {
			N: cost,
			r: blockSize,
			p: parallelization,
			maxmem: 256 * cost * blockSize,
		});
		return timingSafeEqual(actual, expected);
	} catch {
		// Invalid scrypt parameters.
		return false;
	}
}
