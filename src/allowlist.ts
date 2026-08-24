/**
 * Independent server-side validation of the names a client reports.
 *
 * The client only sends publicly known ids, but this endpoint is unauthenticated:
 * anyone can POST anything. Because the aggregates are rendered on a public page,
 * an unvalidated name is user-generated content on our own site. So the server
 * re-derives the allowed vocabulary from the OpenClaw repository's published
 * catalogs and keeps only names that appear there.
 *
 * Failing closed on names is deliberate: if the catalogs cannot be fetched we
 * record counts without names rather than risk publishing attacker-chosen text.
 */

const CATALOG_URLS = [
	"https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/lib/official-external-plugin-catalog.json",
	"https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/lib/official-external-channel-catalog.json",
	"https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/lib/official-external-provider-catalog.json",
] as const;

const CATALOG_CACHE_SECONDS = 21_600;
const CATALOG_TIMEOUT_MS = 5_000;
const CATALOG_CACHE_KEY = "https://telemetry.openclaw.ai/internal/known-names";

/**
 * Bundled plugins ship inside the OpenClaw tarball rather than the external
 * catalogs, and core providers are built in. Neither has a public catalog file,
 * so their ids are listed here and reviewed alongside any other change to what
 * this service will publish.
 */
const BUILT_IN_NAMES = [
	"anthropic",
	"claude",
	"cli",
	"codex",
	"discord",
	"gemini",
	"google",
	"imessage",
	"openai",
	"opencode",
	"signal",
	"slack",
	"telegram",
	"whatsapp",
	"xai",
] as const;

/** OpenClaw releases are `YYYY.M.PATCH` with an optional prerelease suffix. */
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:-[A-Za-z0-9.]{1,32})?$/u;

const UNKNOWN = "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull every declared id out of one catalog entry, whatever kind it is. */
function collectEntryIds(entry: unknown, into: Set<string>): void {
	if (!isRecord(entry)) return;
	const openclaw = isRecord(entry.openclaw) ? entry.openclaw : undefined;
	if (!openclaw) return;
	for (const key of ["plugin", "channel"]) {
		const section = isRecord(openclaw[key]) ? openclaw[key] : undefined;
		const id = section?.id;
		if (typeof id === "string" && id) into.add(id.toLowerCase());
	}
	const providers = openclaw.providers;
	if (Array.isArray(providers)) {
		for (const provider of providers) {
			const id = isRecord(provider) ? provider.id : undefined;
			if (typeof id === "string" && id) into.add(id.toLowerCase());
		}
	}
}

async function fetchKnownNames(): Promise<Set<string> | undefined> {
	const names = new Set<string>(BUILT_IN_NAMES);
	for (const url of CATALOG_URLS) {
		const response = await fetch(url, {
			headers: { accept: "application/json", "user-agent": "openclaw-telemetry-worker" },
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		}).catch(() => undefined);
		if (!response?.ok) return undefined;
		const body = (await response.json().catch(() => undefined)) as unknown;
		const entries = Array.isArray(body)
			? body
			: isRecord(body) && Array.isArray(body.entries)
				? body.entries
				: undefined;
		if (!entries) return undefined;
		for (const entry of entries) collectEntryIds(entry, names);
	}
	return names;
}

/**
 * Cached allowed vocabulary. Stored through the edge cache so a burst of
 * requests cannot turn into a burst of GitHub fetches.
 */
export async function loadKnownNames(): Promise<Set<string> | undefined> {
	const cache = caches.default;
	const cacheKey = new Request(CATALOG_CACHE_KEY);
	const cached = await cache.match(cacheKey);
	if (cached) {
		const body = (await cached.json().catch(() => undefined)) as string[] | undefined;
		if (Array.isArray(body) && body.length > 0) return new Set(body);
	}

	const names = await fetchKnownNames();
	if (!names) return undefined;
	await cache.put(
		cacheKey,
		new Response(JSON.stringify([...names]), {
			headers: {
				"content-type": "application/json",
				"cache-control": `public, max-age=${CATALOG_CACHE_SECONDS}`,
			},
		}),
	);
	return names;
}

export function keepKnownNames(values: string[], known: Set<string> | undefined): string[] {
	if (!known) return [];
	return values.filter((value) => known.has(value.toLowerCase()));
}

/** Version strings render on the public stats page, so reject invented shapes. */
export function normalizeVersion(version: string): string {
	return VERSION_PATTERN.test(version) ? version : UNKNOWN;
}
