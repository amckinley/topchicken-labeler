/**
 * Configuration for the Top Chicken labeller.
 *
 * The "Top Chicken" is a Bluesky meme: a daily crown awarded to the account
 * (under the 7,000-follower "Grace Limit") whose post earned the most likes in a
 * rolling 24h window. The crown is tracked publicly by two accounts in sequence:
 *
 *   - dave.9000ish.uk          -- the original tracker, 2026-05-08 .. 2026-06-06
 *   - topchicken.bsky.social   -- the dedicated bot,     2026-06-06 .. present
 *
 * Both post "🐔 New Top Chicken! @handle's post got N likes." and embed the
 * winner's DID as a mention facet. We mirror that canonical signal rather than
 * recomputing it ourselves.
 *
 * This labeller emits two labels on account DIDs:
 *   - top-chicken         the *current* daily holder (moves; negated + reapplied)
 *   - top-chicken-alumni  *ever* held the crown        (sticky; only ever added)
 */

/** The accounts that announce crownings, oldest first. */
export const ANNOUNCER_HANDLES = ["dave.9000ish.uk", "topchicken.bsky.social"] as const;

/** The live bot the poller watches for new crownings. */
export const BOT_HANDLE = "topchicken.bsky.social";

/** Label values this labeller emits. Must match the declared definitions. */
export const LABEL_CURRENT = "top-chicken";
export const LABEL_ALUMNI = "top-chicken-alumni";

export interface Env {
	/** DID of the labeler account (e.g. did:plc:...). */
	labelerDid: string;
	/** secp256k1 private signing key (hex), from `npx @skyware/labeler setup`. */
	signingKey: string;
	/** Handle or DID used to log in for reading feeds. Defaults to the bot's PDS reads. */
	identifier?: string;
	/** App password for the read account. */
	password?: string;
	/** PDS the read account lives on. */
	pds: string;
	/** Port the labeler HTTP/WS server listens on. */
	port: number;
	/** Path to the SQLite label store (on the Railway volume in prod). */
	dbPath: string;
	/** Path to the small JSON state file tracking the current holder. */
	statePath: string;
	/** How often to poll the bot feed, in milliseconds. */
	pollIntervalMs: number;
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`missing required env var: ${name}`);
	return v;
}

export function loadEnv(): Env {
	// On Railway, RAILWAY_VOLUME_MOUNT_PATH points at the mounted volume (e.g. /data).
	const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? process.env.DATA_DIR ?? "./data";
	return {
		labelerDid: required("LABELER_DID"),
		signingKey: required("SIGNING_KEY"),
		identifier: process.env.BSKY_IDENTIFIER,
		password: process.env.BSKY_APP_PASSWORD,
		pds: process.env.PDS_URL ?? "https://bsky.social",
		port: Number(process.env.PORT ?? 4100),
		dbPath: process.env.DB_PATH ?? `${volume}/labels.db`,
		statePath: process.env.STATE_PATH ?? `${volume}/state.json`,
		pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5 * 60_000),
	};
}
