export type Env = {
	TELEMETRY: AnalyticsEngineDataset;
	/** Cloudflare account id, used only by the public /api/stats aggregation query. */
	ACCOUNT_ID?: string;
	/** Read-only Analytics Engine token for /api/stats. Absent = stats unavailable. */
	ANALYTICS_READ_TOKEN?: string;
};
