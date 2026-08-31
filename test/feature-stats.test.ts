import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readFeatureStats } from "../src/feature-stats.js";

const FEATURE_BODY = JSON.stringify({
	schema: 1,
	features: {
		channels: ["telegram"],
		providerFamilies: ["anthropic"],
		plugins: ["codex"],
		pluginsEnabled: 1,
		sessionsLast24h: 2,
	},
});

type StreamRequestInit = RequestInit & { duplex: "half" };

function postStream(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
	return new Request("https://telemetry.example/api/latest-version", {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as StreamRequestInit);
}

function countingBody(totalBytes: number, chunkSize: number) {
	const state = { pulled: 0 };
	const chunk = new Uint8Array(chunkSize);
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulled >= totalBytes) {
				controller.close();
				return;
			}
			const next = Math.min(chunkSize, totalBytes - state.pulled);
			state.pulled += next;
			controller.enqueue(next === chunkSize ? chunk : chunk.subarray(0, next));
		},
	});
	return { stream, state };
}

describe("readFeatureStats", () => {
	it("accepts a documented POST body under the cap", async () => {
		const request = new Request("https://telemetry.example/api/latest-version", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: FEATURE_BODY,
		});
		await expect(readFeatureStats(request)).resolves.toMatchObject({
			channels: ["telegram"],
			pluginsEnabled: 1,
			sessionsLast24h: 2,
		});
	});

	it("rejects a huge body with no Content-Length before reading the whole stream", async () => {
		const chunkSize = 4_096;
		const totalBytes = 1_048_576;
		const { stream, state } = countingBody(totalBytes, chunkSize);
		const stats = await readFeatureStats(postStream(stream));
		expect(stats).toBeUndefined();
		expect(state.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + chunkSize);
		expect(state.pulled).toBeLessThan(totalBytes);
	});

	it("rejects a non-numeric Content-Length without reading the body", async () => {
		const chunkSize = 4_096;
		const totalBytes = 1_048_576;
		const { stream, state } = countingBody(totalBytes, chunkSize);
		const stats = await readFeatureStats(postStream(stream, { "content-length": "nope" }));
		expect(stats).toBeUndefined();
		// undici may prefetch one chunk when constructing Request
		expect(state.pulled).toBeLessThanOrEqual(chunkSize);
		expect(state.pulled).toBeLessThan(totalBytes);
	});

	it("still caps the stream when Content-Length understates the body", async () => {
		const chunkSize = 4_096;
		const totalBytes = 1_048_576;
		const { stream, state } = countingBody(totalBytes, chunkSize);
		const stats = await readFeatureStats(postStream(stream, { "content-length": "100" }));
		expect(stats).toBeUndefined();
		expect(state.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + chunkSize);
		expect(state.pulled).toBeLessThan(totalBytes);
	});
});
