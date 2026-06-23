/**
 * Extract the canonical Top Chicken crowning history from the announcer accounts.
 *
 * Both dave.9000ish.uk and topchicken.bsky.social post crowning announcements of
 * the form "🐔 New Top Chicken! @handle's post got N likes." with the winner's
 * DID embedded as a mention facet. We parse those facets directly, so we get the
 * winner's DID for free and never have to resolve a handle (robust against handle
 * changes and the public-API bot blocking).
 */
import { AtpAgent, AppBskyFeedDefs, AppBskyFeedPost, AppBskyRichtextFacet } from "@atproto/api";
import { ANNOUNCER_HANDLES } from "./config.js";

const CROWN_RE = /New Top Chicken!\s*@([\w.\-]+)'s post got ([\d,]+) likes/;

export interface Crowning {
	/** ISO timestamp of the announcement (post createdAt). */
	ts: string;
	/** Winner handle as written in the announcement (may be stale; DID is canonical). */
	handle: string;
	/** Winner DID, pulled from the announcement's mention facet. */
	did: string;
	/** Like count of the winning post, as announced. */
	likes: number;
	/** Which announcer posted it. */
	source: string;
	/** AT-URI of the announcement post itself. */
	announceUri: string;
}

export interface CrowningHistory {
	/** All crownings, chronological. */
	crownings: Crowning[];
	/** did -> { handle, bestLikes } for every account that ever held the crown. */
	alumni: Map<string, { handle: string; bestLikes: number }>;
	/** The current (most recent) holder, or null if none found. */
	current: Crowning | null;
}

/**
 * Resolve the winner's DID from the announcement's mention facets.
 *
 * Facets index byte ranges in the UTF-8 post text. We match the facet whose text
 * is exactly `@<handle>` (the handle the regex already parsed) rather than taking
 * the first mention globally — so an announcement that ever mentions someone else
 * before the winner can't misattribute the crown. Falls back to the first mention
 * if no facet text matches (e.g. trailing-dot handle normalization quirks).
 */
function winnerMentionDid(record: AppBskyFeedPost.Record, handle: string): string | null {
	const bytes = Buffer.from(record.text, "utf8");
	const target = `@${handle}`;
	let firstMention: string | null = null;
	for (const facet of record.facets ?? []) {
		const slice = bytes.subarray(facet.index.byteStart, facet.index.byteEnd).toString("utf8");
		for (const feature of facet.features) {
			if (!AppBskyRichtextFacet.isMention(feature)) continue;
			if (firstMention === null) firstMention = feature.did;
			if (slice === target) return feature.did;
		}
	}
	return firstMention;
}

async function fetchAuthorFeed(
	agent: AtpAgent,
	actor: string,
): Promise<AppBskyFeedDefs.FeedViewPost[]> {
	const out: AppBskyFeedDefs.FeedViewPost[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 80; page++) {
		const res = await agent.app.bsky.feed.getAuthorFeed({
			actor,
			limit: 100,
			filter: "posts_with_replies",
			cursor,
		});
		out.push(...res.data.feed);
		cursor = res.data.cursor;
		if (!cursor || res.data.feed.length === 0) break;
	}
	return out;
}

/** Parse crowning announcements out of an already-fetched feed. */
export function parseCrownings(
	feed: AppBskyFeedDefs.FeedViewPost[],
	source: string,
): Crowning[] {
	const crownings: Crowning[] = [];
	for (const item of feed) {
		if (!AppBskyFeedPost.isRecord(item.post.record)) continue;
		// isRecord only narrows the $type tag, not the full shape; cast to the
		// concrete record type now that we know it's a post record.
		const record = item.post.record as AppBskyFeedPost.Record;
		const m = CROWN_RE.exec(record.text);
		if (!m) continue;
		const did = winnerMentionDid(record, m[1]);
		if (!did) continue; // no mention facet -> can't resolve a subject safely; skip.
		crownings.push({
			ts: (record.createdAt ?? "").slice(0, 19),
			handle: m[1],
			did,
			likes: Number(m[2].replace(/,/g, "")),
			source,
			announceUri: item.post.uri,
		});
	}
	return crownings;
}

/** Fetch and assemble the full crowning history across all announcer accounts. */
export async function buildHistory(agent: AtpAgent): Promise<CrowningHistory> {
	const all: Crowning[] = [];
	for (const handle of ANNOUNCER_HANDLES) {
		const feed = await fetchAuthorFeed(agent, handle);
		all.push(...parseCrownings(feed, handle));
	}
	return summarize(all);
}

/** Dedupe + sort + derive alumni and current holder from raw crownings. */
export function summarize(raw: Crowning[]): CrowningHistory {
	const sorted = [...raw].sort((a, b) => a.ts.localeCompare(b.ts));

	// Dedupe identical crownings that appear on both feeds during the 2026-06-06 handover.
	const seen = new Set<string>();
	const crownings: Crowning[] = [];
	for (const c of sorted) {
		const key = `${c.ts.slice(0, 10)}|${c.did}|${c.likes}`;
		if (seen.has(key)) continue;
		seen.add(key);
		crownings.push(c);
	}

	const alumni = new Map<string, { handle: string; bestLikes: number }>();
	for (const c of crownings) {
		const prev = alumni.get(c.did);
		if (!prev || c.likes > prev.bestLikes) {
			alumni.set(c.did, { handle: c.handle, bestLikes: c.likes });
		}
	}

	return {
		crownings,
		alumni,
		current: crownings.at(-1) ?? null,
	};
}

/**
 * Fetch only the most recent crowning from the live bot. Cheaper than a full
 * history rebuild; used by the poller's hot path.
 */
export async function fetchLatestCrowning(
	agent: AtpAgent,
	botHandle: string,
): Promise<Crowning | null> {
	const res = await agent.app.bsky.feed.getAuthorFeed({
		actor: botHandle,
		limit: 25,
		filter: "posts_with_replies",
	});
	const crownings = parseCrownings(res.data.feed, botHandle);
	// parseCrownings preserves feed order (newest first from the API); pick the newest by ts.
	crownings.sort((a, b) => b.ts.localeCompare(a.ts));
	return crownings[0] ?? null;
}
