/**
 * Top Chicken labeller service.
 *
 * Two responsibilities, one long-lived process (single Railway replica):
 *   1. Run a LabelerServer (com.atproto.label.queryLabels + subscribeLabels) that
 *      serves and signs labels, persisting them to SQLite on the mounted volume.
 *   2. Poll the canonical @topchicken.bsky.social feed; when the crown moves,
 *      transfer the `top-chicken` label and grant `top-chicken-alumni`, and when
 *      a new all-time record is set, move the `tiptop-chicken` (TipTop) crown.
 */
import { AtpAgent } from "@atproto/api";
import { LabelerServer } from "@skyware/labeler";
import { loadEnv, BOT_HANDLE, LABEL_WINNING_POST, type Env } from "./config.js";
import { buildHistory, fetchLatestCrowning } from "./crownings.js";
import { transferCrown, transferGrandmaster, reemitActiveLabels } from "./labeler.js";
import { readState, writeState } from "./state.js";

function log(msg: string, extra?: Record<string, unknown>): void {
	const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
	console.log(`[${new Date().toISOString()}] ${line}`);
}

/** Build a read-only agent. Auth is optional but avoids public-API bot blocking. */
async function makeAgent(env: Env): Promise<AtpAgent> {
	const agent = new AtpAgent({ service: env.pds });
	if (env.identifier && env.password) {
		await agent.login({ identifier: env.identifier, password: env.password });
		log("logged in for feed reads", { identifier: env.identifier });
	} else {
		log("no read credentials set; using unauthenticated reads (may be rate-limited/blocked)");
	}
	return agent;
}

/** One poll: check the latest crowning and transfer the crown if it changed. */
async function pollOnce(env: Env, agent: AtpAgent, server: LabelerServer): Promise<void> {
	const latest = await fetchLatestCrowning(agent, BOT_HANDLE);
	if (!latest) {
		log("poll: no crowning found in recent feed");
		return;
	}

	const state = await readState(env.statePath);
	const next = { ...state };
	let acted = false;

	// 1. Daily crown. Dedupe on DID only, intentionally: the crown is a single
	//    label that only needs to move when the *holder* changes. A same-holder
	//    re-coronation (same DID winning two days running) leaves them already
	//    wearing `top-chicken`, so re-emitting it would just append a redundant
	//    entry to the log for no user-visible change. (transferCrown's same-holder
	//    path exists for backfill/recovery, not this hot path.)
	if (state.currentHolderDid !== latest.did) {
		log("poll: crown moved", {
			from: state.currentHolderDid,
			to: latest.did,
			handle: latest.handle,
			likes: latest.likes,
		});
		const { negated, created } = await transferCrown(server, state.currentHolderDid, latest.did);
		log("labels updated", { negated, created });
		next.currentHolderDid = latest.did;
		next.currentSince = latest.ts;
		acted = true;
	}

	// 2. All-time record (TipTop Chicken). Independent of the daily dedupe: the
	//    record can be broken even by the same DID re-crowned with a higher score.
	//    Strictly-greater so a tie doesn't dethrone the existing record holder.
	//
	//    Seeding the record is the backfill's job, not the poller's: it requires the
	//    *full* history to know the true all-time max. If recordScore is null here
	//    (fresh DB, or an old pre-record state file that readState filled with null),
	//    we must NOT treat the latest single crowning as the record — that would
	//    crown a non-record post and persist a too-low score. Skip until a backfill
	//    has seeded it, and say so loudly.
	if (state.recordScore === null) {
		log("poll: record state unseeded; run backfill to set the TipTop crown — skipping record check");
	} else if (latest.likes > state.recordScore) {
		log("poll: new all-time record", {
			from: state.recordHolderDid,
			to: latest.did,
			handle: latest.handle,
			likes: latest.likes,
			previousRecord: state.recordScore,
		});
		const { negated, created } = await transferGrandmaster(server, state.recordHolderDid, latest.did);
		log("grandmaster updated", { negated, created });
		next.recordHolderDid = latest.did;
		next.recordScore = latest.likes;
		acted = true;
	}

	if (!acted) {
		log("poll: no change", { holder: latest.handle, did: latest.did });
		return;
	}
	await writeState(env.statePath, next);
}

async function main(): Promise<void> {
	const env = loadEnv();
	log("starting top chicken labeller", {
		did: env.labelerDid,
		port: env.port,
		dbPath: env.dbPath,
		pollIntervalMs: env.pollIntervalMs,
	});

	const server = new LabelerServer({ did: env.labelerDid, signingKey: env.signingKey, dbPath: env.dbPath });

	await new Promise<void>((resolve, reject) => {
		server.start({ port: env.port, host: "0.0.0.0" }, (err, address) => {
			if (err) return reject(err);
			log("labeler server listening", { address });
			resolve();
		});
	});

	// WebSocket keepalive. Railway's edge proxy closes idle WebSocket connections
	// after ~45s. skyware's subscribeLabels sends no ping frames, so once the AppView
	// ingester (Vortex) has received the label backlog the connection goes idle and
	// Railway kills it at 45s — Vortex reconnects, gets the backlog, idles, dies, on
	// a loop, and never stabilizes enough to ingest. Pinging every live subscriber
	// keeps the connection alive past the idle timeout. (Confirmed in Vortex's logs:
	// connect → 101 → close 1006 at exactly 45s.)
	const KEEPALIVE_MS = 30_000;
	// `connections` is typed private but is a real instance field skyware populates.
	const connections = (server as unknown as {
		connections: Map<string, Set<unknown>>;
	}).connections;
	const keepalive = setInterval(() => {
		const subs = connections.get("com.atproto.label.subscribeLabels");
		if (!subs || subs.size === 0) return;
		let pinged = 0;
		for (const ws of subs) {
			const sock = ws as unknown as { readyState: number; ping?: () => void };
			if (sock.readyState === 1 && typeof sock.ping === "function") {
				try {
					sock.ping();
					pinged++;
				} catch {
					/* ignore; close handler will evict it */
				}
			}
		}
		if (pinged > 0) log("keepalive ping", { subscribers: pinged });
	}, KEEPALIVE_MS);
	keepalive.unref?.();

	// REEMIT_LABELS: one-shot repair. Labels written by the backfill (a separate
	// process) never broadcast live on the AppView ingester's open connection, so
	// if its resume cursor sits at/past them they never get ingested. Re-emitting
	// from the running server appends fresh higher-seq rows that broadcast live and
	// sit above any cursor — the fix Bluesky's labeler ops prescribe. Set the env
	// var, deploy once, confirm labels appear, then unset it (leaving it on just
	// re-emits the same active set on every boot — harmless but noisy).
	if (process.env.REEMIT_LABELS) {
		try {
			const n = await reemitActiveLabels(server);
			log("REEMIT_LABELS: re-emitted active label set from running server", { count: n });
		} catch (err) {
			log("REEMIT_LABELS error", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	const agent = await makeAgent(env);

	// LABEL_WINNING_POSTS=N: one-shot. Emit record-level `top-chicken-post` labels
	// on the N most recent winning posts (AT-URIs pulled from the announcers' quote
	// embeds), live from the running server. Doubles as a probe: if these appear in
	// the AppView, Vortex is fully consuming our live output. Set, deploy once, then
	// unset.
	const winN = Number(process.env.LABEL_WINNING_POSTS ?? 0);
	if (winN > 0) {
		try {
			const history = await buildHistory(agent);
			const withPosts = history.crownings.filter((c) => c.postUri).slice(-winN);
			let n = 0;
			for (const c of withPosts) {
				await server.createLabels(
					{ uri: c.postUri!, ...(c.postCid ? { cid: c.postCid } : {}) },
					{ create: [LABEL_WINNING_POST] },
				);
				n++;
				log("labeled winning post", { handle: c.handle, uri: c.postUri, likes: c.likes });
			}
			log("LABEL_WINNING_POSTS: done", { labeled: n });
		} catch (err) {
			log("LABEL_WINNING_POSTS error", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Run an initial poll immediately, then on the configured interval. Poll
	// failures are logged but never crash the loop (the label server keeps serving).
	const tick = async () => {
		try {
			await pollOnce(env, agent, server);
		} catch (err) {
			log("poll error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	await tick();
	// Reentrancy guard: setInterval doesn't await tick, so a poll slower than the
	// interval could otherwise overlap with the next one — two ticks reading the
	// same stale state and both emitting label writes (check-then-act race).
	let polling = false;
	const timer = setInterval(async () => {
		if (polling) {
			log("poll: previous tick still running; skipping");
			return;
		}
		polling = true;
		try {
			await tick();
		} finally {
			polling = false;
		}
	}, env.pollIntervalMs);

	const shutdown = (sig: string) => {
		log("shutting down", { sig });
		clearInterval(timer);
		server.stop(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
	log("fatal", { error: err instanceof Error ? err.stack : String(err) });
	process.exit(1);
});
