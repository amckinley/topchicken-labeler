/**
 * Top Chicken labeller service.
 *
 * Two responsibilities, one long-lived process (single Railway replica):
 *   1. Run a LabelerServer (com.atproto.label.queryLabels + subscribeLabels) that
 *      serves and signs labels, persisting them to SQLite on the mounted volume.
 *   2. Poll the canonical @topchicken.bsky.social feed; when the crown moves,
 *      transfer the `top-chicken` label and grant `top-chicken-alumni`.
 */
import { AtpAgent } from "@atproto/api";
import { LabelerServer } from "@skyware/labeler";
import { loadEnv, BOT_HANDLE, type Env } from "./config.js";
import { fetchLatestCrowning } from "./crownings.js";
import { transferCrown } from "./labeler.js";
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
	// Dedupe on DID only, intentionally: the crown is a single label that only
	// needs to move when the *holder* changes. A same-holder re-coronation (the
	// same DID winning two days running) leaves them already wearing `top-chicken`,
	// so re-emitting it would just append a redundant entry to the label log for no
	// user-visible change. (transferCrown's same-holder path exists for backfill /
	// recovery, where the label DB may not reflect reality — not for this hot path.)
	if (state.currentHolderDid === latest.did) {
		log("poll: no change", { holder: latest.handle, did: latest.did });
		return;
	}

	log("poll: crown moved", {
		from: state.currentHolderDid,
		to: latest.did,
		handle: latest.handle,
		likes: latest.likes,
	});

	const { negated, created } = await transferCrown(server, state.currentHolderDid, latest.did);
	log("labels updated", { negated, created });

	await writeState(env.statePath, {
		currentHolderDid: latest.did,
		currentSince: latest.ts,
	});
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
