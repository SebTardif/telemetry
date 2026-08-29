import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

type MemoryCache = {
	store: Map<string, Response>;
	match(request: RequestInfo | URL): Promise<Response | undefined>;
	put(request: RequestInfo | URL, response: Response): Promise<void>;
};

function memoryCache(): MemoryCache {
	const store = new Map<string, Response>();
	return {
		store,
		async match(request) {
			const url = request instanceof Request ? request.url : String(request);
			return store.get(url)?.clone();
		},
		async put(request, response) {
			const url = request instanceof Request ? request.url : String(request);
			store.set(url, response);
		},
	};
}

function sqlResponse(): Response {
	return new Response(
		JSON.stringify({
			data: [
				{
					version: "2026.8.2",
					platform: "darwin",
					channels: "telegram",
					providers: "anthropic",
					plugins: "codex",
					pings: 4,
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		TELEMETRY: { writeDataPoint() {} },
		ACCOUNT_ID: "acct",
		ANALYTICS_READ_TOKEN: "tok",
		...overrides,
	};
}

describe("GET /api/stats", () => {
	let sqlCalls: number;
	let cache: MemoryCache;

	beforeEach(() => {
		sqlCalls = 0;
		cache = memoryCache();
		vi.stubGlobal("caches", { default: cache });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/analytics_engine/sql")) {
				sqlCalls += 1;
				return sqlResponse();
			}
			throw new Error(`unexpected fetch ${url}`);
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("runs three Analytics Engine queries on a cold request", async () => {
		const response = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			testEnv(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=600");
		expect(sqlCalls).toBe(3);
		const body = (await response.json()) as { versions: Array<{ version: string }> };
		expect(body.versions[0]?.version).toBe("2026.8.2");
	});

	it("serves a second request from caches.default without more SQL", async () => {
		const first = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			testEnv(),
		);
		const firstBody = await first.json();
		expect(sqlCalls).toBe(3);

		const second = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			testEnv(),
		);
		expect(second.status).toBe(200);
		expect(sqlCalls).toBe(3);
		expect(cache.store.size).toBe(1);
		await expect(second.json()).resolves.toEqual(firstBody);
	});

	it("rate-limits a cache miss before queryPublicStats", async () => {
		const limiter = {
			calls: 0,
			async limit() {
				limiter.calls += 1;
				return { success: false };
			},
		};
		const response = await worker.fetch(
			new Request("https://telemetry.example/api/stats", {
				headers: { "cf-connecting-ip": "203.0.113.9" },
			}),
			testEnv({ RATE_LIMIT: limiter }),
		);
		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
		expect(limiter.calls).toBe(1);
		expect(sqlCalls).toBe(0);
		expect(cache.store.size).toBe(0);
	});
});
