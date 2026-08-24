import { describe, expect, it } from "vitest";
import { keepKnownNames, normalizeVersion } from "../src/allowlist.js";

describe("normalizeVersion", () => {
	it("accepts published OpenClaw release shapes", () => {
		for (const version of ["2026.8.2", "2026.12.0", "2026.7.1-2", "2026.8.0-beta.3"]) {
			expect(normalizeVersion(version)).toBe(version);
		}
	});

	it("buckets invented version strings so they cannot reach the public page", () => {
		for (const version of ["unknown", "BUY-CRYPTO-NOW", "1.0.0", "99999.1.1.1", ""]) {
			expect(normalizeVersion(version)).toBe("unknown");
		}
	});
});

describe("keepKnownNames", () => {
	const known = new Set(["discord", "telegram", "codex"]);

	it("keeps names the catalog vouches for, case-insensitively", () => {
		expect(keepKnownNames(["discord", "TELEGRAM"], known)).toEqual(["discord", "TELEGRAM"]);
	});

	it("drops names no catalog declares, including attacker-supplied text", () => {
		expect(keepKnownNames(["discord", "acme-internal-crm", "spam-link"], known)).toEqual(["discord"]);
	});

	it("fails closed when the catalog is unavailable rather than publishing unverified names", () => {
		expect(keepKnownNames(["discord", "telegram"], undefined)).toEqual([]);
	});
});
