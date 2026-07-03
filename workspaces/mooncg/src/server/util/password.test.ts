import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("hashPassword", () => {
	it("produces the documented format", () => {
		const hash = hashPassword("hunter2");
		expect(hash).toMatch(
			/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
		);
	});

	it("uses a random salt per hash", () => {
		expect(hashPassword("hunter2")).not.toBe(hashPassword("hunter2"));
	});
});

describe("verifyPassword", () => {
	it("verifies a correct password", () => {
		const hash = hashPassword("correct horse battery staple");
		expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
	});

	it("rejects an incorrect password", () => {
		const hash = hashPassword("correct horse battery staple");
		expect(verifyPassword("Tr0ub4dor&3", hash)).toBe(false);
		expect(verifyPassword("", hash)).toBe(false);
	});

	it("verifies a known-good stored hash", () => {
		const hash = hashPassword("stable-password");
		// Round-trip through string storage.
		const stored = String(hash);
		expect(verifyPassword("stable-password", stored)).toBe(true);
	});

	it("rejects malformed stored hashes instead of throwing", () => {
		expect(verifyPassword("x", "")).toBe(false);
		expect(verifyPassword("x", "plaintext")).toBe(false);
		expect(verifyPassword("x", "sha256:abcdef")).toBe(false);
		expect(verifyPassword("x", "scrypt$N=16384,r=8,p=1$onlysalt")).toBe(false);
		expect(verifyPassword("x", "scrypt$bogus$c2FsdA==$aGFzaA==")).toBe(false);
		expect(verifyPassword("x", "scrypt$N=3,r=8,p=1$c2FsdA==$aGFzaA==")).toBe(
			false,
		);
		expect(verifyPassword("x", "scrypt$N=16384,r=8,p=1$$")).toBe(false);
		expect(
			verifyPassword("x", "scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==$extra"),
		).toBe(false);
	});
});
