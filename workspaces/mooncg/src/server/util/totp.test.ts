import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";

import {
	buildOtpauthUrl,
	generateTotpSecret,
	generateTotpToken,
	verifyTotpToken,
} from "./totp";

// Fixed secret + timestamp so that these tests are fully deterministic.
const FIXED_SECRET = "JBSWY3DPEHPK3PXP";
const FIXED_TIMESTAMP = 1_700_000_000_000;

describe("generateTotpSecret", () => {
	it("generates a base32 secret usable by otpauth", () => {
		const secret = generateTotpSecret();
		expect(secret).toMatch(/^[A-Z2-7]+$/);
		expect(() => OTPAuth.Secret.fromBase32(secret)).not.toThrow();
	});
});

describe("buildOtpauthUrl", () => {
	it("builds an otpauth URL containing issuer, label and secret", () => {
		const url = buildOtpauthUrl(FIXED_SECRET, "some-user");
		expect(url.startsWith("otpauth://totp/")).toBe(true);
		expect(url).toContain("issuer=MoonCG");
		expect(url).toContain("some-user");
		expect(url).toContain(`secret=${FIXED_SECRET}`);
	});
});

describe("verifyTotpToken", () => {
	it("accepts a token generated for the same time step", () => {
		const token = generateTotpToken(FIXED_SECRET, FIXED_TIMESTAMP);
		expect(verifyTotpToken(FIXED_SECRET, token, FIXED_TIMESTAMP)).toBe(true);
	});

	it("accepts tokens within the +/- 1 step window", () => {
		const token = generateTotpToken(FIXED_SECRET, FIXED_TIMESTAMP);
		expect(verifyTotpToken(FIXED_SECRET, token, FIXED_TIMESTAMP + 30_000)).toBe(
			true,
		);
		expect(verifyTotpToken(FIXED_SECRET, token, FIXED_TIMESTAMP - 30_000)).toBe(
			true,
		);
	});

	it("rejects tokens outside the window", () => {
		const token = generateTotpToken(FIXED_SECRET, FIXED_TIMESTAMP);
		expect(verifyTotpToken(FIXED_SECRET, token, FIXED_TIMESTAMP + 90_000)).toBe(
			false,
		);
		expect(verifyTotpToken(FIXED_SECRET, token, FIXED_TIMESTAMP - 90_000)).toBe(
			false,
		);
	});

	it("rejects wrong tokens", () => {
		const token = generateTotpToken(FIXED_SECRET, FIXED_TIMESTAMP);
		const wrongToken = token === "000000" ? "111111" : "000000";
		expect(verifyTotpToken(FIXED_SECRET, wrongToken, FIXED_TIMESTAMP)).toBe(
			false,
		);
	});

	it("rejects tokens for a different secret", () => {
		const token = generateTotpToken(FIXED_SECRET, FIXED_TIMESTAMP);
		expect(
			verifyTotpToken("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", token, FIXED_TIMESTAMP),
		).toBe(false);
	});

	it("rejects malformed input instead of throwing", () => {
		expect(verifyTotpToken("not-base32!!", "123456", FIXED_TIMESTAMP)).toBe(
			false,
		);
		expect(verifyTotpToken(FIXED_SECRET, "", FIXED_TIMESTAMP)).toBe(false);
		expect(verifyTotpToken(FIXED_SECRET, "abc", FIXED_TIMESTAMP)).toBe(false);
	});
});
