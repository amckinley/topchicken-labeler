/**
 * One-time backfill of the full Top Chicken history.
 *
 * Reads every crowning ever announced (dave.9000ish.uk + topchicken.bsky.social),
 * then:
 *   - grants `top-chicken-alumni` to every account that ever held the crown
 *   - grants the current `top-chicken` crown to the most recent holder
 *   - writes the holder state file so the live poller picks up seamlessly
 *
 * Idempotent enough to re-run: duplicate alumni labels are harmless (clients
 * dedupe), and the crown is set to whoever is current.
 *
 *   LABELER_DID=... SIGNING_KEY=... [BSKY_IDENTIFIER=... BSKY_APP_PASSWORD=...] \
 *     npm run backfill
 */
import { AtpAgent } from "@atproto/api";
import { LabelerServer } from "@skyware/labeler";
import { loadEnv } from "./config.js";
import { buildHistory } from "./crownings.js";
import { transferCrown, grantAlumni, negateCurrent } from "./labeler.js";
import { writeState } from "./state.js";

async function main(): Promise<void> {
	const env = loadEnv();

	const agent = new AtpAgent({ service: env.pds });
	if (env.identifier && env.password) {
		await agent.login({ identifier: env.identifier, password: env.password });
	}

	console.log("building crowning history from announcer feeds...");
	const history = await buildHistory(agent);
	console.log(
		`found ${history.crownings.length} crownings, ${history.alumni.size} distinct alumni`,
	);
	if (!history.current) throw new Error("no crownings found; aborting");

	// Open the same label store the live server uses. We don't start the HTTP
	// server here — createLabels writes + signs directly into the DB.
	const server = new LabelerServer({
		did: env.labelerDid,
		signingKey: env.signingKey,
		dbPath: env.dbPath,
	});

	// 1. Alumni for everyone who ever held it.
	let n = 0;
	for (const [did, info] of history.alumni) {
		await grantAlumni(server, did);
		n++;
		console.log(`  alumni ${n}/${history.alumni.size}: @${info.handle} (${info.bestLikes}) ${did}`);
	}

	// 2. Repair the single `top-chicken` crown authoritatively. A backfill is the
	//    one place we hold the *complete* history, so we don't trust the state
	//    sidecar (it may be missing, stale, or the old buggy code may have left
	//    several active crowns): negate the crown off every historical holder that
	//    isn't the current one, then crown the current holder.
	const current = history.current;
	for (const did of history.alumni.keys()) {
		if (did !== current.did) await negateCurrent(server, did);
	}
	const { created } = await transferCrown(server, null, current.did);
	console.log(`current crown -> @${current.handle} (${current.did}): ${created.join(", ")}`);

	// 3. Seed the holder state so the poller continues from here without re-acting.
	await writeState(env.statePath, {
		currentHolderDid: current.did,
		currentSince: current.ts,
	});

	console.log("backfill complete.");
	server.stop(() => process.exit(0));
}

main().catch((err) => {
	console.error("backfill failed:", err instanceof Error ? err.stack : err);
	process.exit(1);
});
