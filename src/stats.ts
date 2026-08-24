import type { Env } from "./env.js";

/**
 * Public aggregate view. Everything this returns is already published on the
 * stats page, so the query is fixed here rather than driven by request input.
 */
export type PublicStats = {
	generatedAt: string;
	windowDays: number;
	versions: Array<{ version: string; pings: number }>;
	platforms: Array<{ platform: string; pings: number }>;
	channels: Array<{ channel: string; installs: number }>;
	providerFamilies: Array<{ provider: string; installs: number }>;
};

const WINDOW_DAYS = 7;
const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const QUERY_TIMEOUT_MS = 10_000;

type SqlRow = Record<string, string | number>;

async function runQuery(env: Env, sql: string): Promise<SqlRow[] | undefined> {
	if (!env.ACCOUNT_ID || !env.ANALYTICS_READ_TOKEN) return undefined;
	const response = await fetch(`${SQL_ENDPOINT}/${env.ACCOUNT_ID}/analytics_engine/sql`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`,
			"content-type": "text/plain",
		},
		body: sql,
		signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
	}).catch(() => undefined);
	if (!response?.ok) return undefined;
	const body = (await response.json().catch(() => undefined)) as { data?: SqlRow[] } | undefined;
	return body?.data;
}

function toCount(value: string | number | undefined): number {
	const parsed = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function text(value: string | number | undefined): string {
	return typeof value === "string" ? value : String(value ?? "");
}

export async function queryPublicStats(env: Env): Promise<PublicStats | undefined> {
	const since = `NOW() - INTERVAL '${WINDOW_DAYS}' DAY`;
	const [versionRows, platformRows, featureRows] = await Promise.all([
		runQuery(
			env,
			`SELECT blob1 AS version, SUM(_sample_interval) AS pings FROM openclaw_telemetry
			 WHERE timestamp > ${since} GROUP BY version ORDER BY pings DESC LIMIT 25`,
		),
		runQuery(
			env,
			`SELECT blob2 AS platform, SUM(_sample_interval) AS pings FROM openclaw_telemetry
			 WHERE timestamp > ${since} GROUP BY platform ORDER BY pings DESC LIMIT 25`,
		),
		runQuery(
			env,
			`SELECT blob6 AS channels, blob7 AS providers, SUM(_sample_interval) AS pings FROM openclaw_telemetry
			 WHERE timestamp > ${since} AND double1 = 1 GROUP BY channels, providers LIMIT 1000`,
		),
	]);
	if (!versionRows || !platformRows) return undefined;

	// Feature lists arrive as comma-joined blobs; fan them back out per install.
	const channelTotals = new Map<string, number>();
	const providerTotals = new Map<string, number>();
	for (const row of featureRows ?? []) {
		const pings = toCount(row.pings);
		for (const channel of text(row.channels).split(",").filter(Boolean)) {
			channelTotals.set(channel, (channelTotals.get(channel) ?? 0) + pings);
		}
		for (const provider of text(row.providers).split(",").filter(Boolean)) {
			providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + pings);
		}
	}

	const rank = (totals: Map<string, number>) =>
		[...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

	return {
		generatedAt: new Date().toISOString(),
		windowDays: WINDOW_DAYS,
		versions: versionRows.map((row) => ({ version: text(row.version), pings: toCount(row.pings) })),
		platforms: platformRows.map((row) => ({ platform: text(row.platform), pings: toCount(row.pings) })),
		channels: rank(channelTotals).map(([channel, installs]) => ({ channel, installs })),
		providerFamilies: rank(providerTotals).map(([provider, installs]) => ({ provider, installs })),
	};
}
