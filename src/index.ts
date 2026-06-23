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
import { loadEnv, BOT_HANDLE, type Env } from "./config.js";
import { fetchLatestCrowning } from "./crownings.js";
import { transferCrown, transferGrandmaster } from "./labeler.js";
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

	// IGNORE_SEQUENCE: force subscribeLabels to replay from cursor 0 regardless of
	// the cursor the consumer sends. The AppView tracks a per-labeler cursor; if it
	// ever advances past labels it didn't actually persist (e.g. labels written by a
	// separate backfill process that never live-emitted on the AppView's connection),
	// those labels are stranded — a normal reconnect replays only `id > cursor` and
	// skips them. Rewriting the cursor to 0 on connect makes the next reconnect
	// re-ingest the full label set. Flip this on to repair sync, then turn it off.
	// (skyware's handler reads req.query.cursor, so an onRequest hook can rewrite it.)
	if (process.env.IGNORE_SEQUENCE) {
		server.app.addHook("onRequest", (req, _reply, done) => {
			if (req.url.includes("com.atproto.label.subscribeLabels")) {
				const q = req.query as Record<string, unknown>;
				log("IGNORE_SEQUENCE: forcing subscribeLabels cursor to 0", { from: q.cursor });
				q.cursor = "0";
			}
			done();
		});
	}

	await new Promise<void>((resolve, reject) => {
		server.start({ port: env.port, host: "0.0.0.0" }, (err, address) => {
			if (err) return reject(err);
			log("labeler server listening", { address });
			resolve();
		});
	});

	const agent = await makeAgent(env);

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
