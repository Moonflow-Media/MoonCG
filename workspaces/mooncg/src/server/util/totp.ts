import * as OTPAuth from "otpauth";

const ISSUER = "MoonCG";
const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = "SHA1";

/**
 * How many time steps (in each direction) a token may be off
 * and still be accepted.
 */
const VALIDATION_WINDOW = 1;

function createTotp(secretBase32: string, label?: string): OTPAuth.TOTP {
	return new OTPAuth.TOTP({
		issuer: ISSUER,
		label: label ?? ISSUER,
		algorithm: ALGORITHM,
		digits: DIGITS,
		period: PERIOD,
		secret: OTPAuth.Secret.fromBase32(secretBase32),
	});
}

/**
 * Generates a new random base32-encoded TOTP secret.
 */
export function generateTotpSecret(): string {
	return new OTPAuth.Secret({ size: 20 }).base32;
}

/**
 * Builds the otpauth:// enrollment URL for authenticator apps.
 */
export function buildOtpauthUrl(secretBase32: string, label: string): string {
	return createTotp(secretBase32, label).toString();
}

/**
 * Generates the TOTP token for the given secret.
 * Mainly useful for tests; `timestamp` defaults to now.
 */
export function generateTotpToken(
	secretBase32: string,
	timestamp?: number,
): string {
	return createTotp(secretBase32).generate({
		timestamp: timestamp ?? Date.now(),
	});
}

/**
 * Verifies a TOTP token against the given secret.
 * Returns false (instead of throwing) for malformed secrets/tokens.
 */
export function verifyTotpToken(
	secretBase32: string,
	token: string,
	timestamp?: number,
): boolean {
	try {
		const delta = createTotp(secretBase32).validate({
			token,
			window: VALIDATION_WINDOW,
			timestamp: timestamp ?? Date.now(),
		});
		return delta !== null;
	} catch {
		return false;
	}
}
