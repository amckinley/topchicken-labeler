/**
 * Recreate the labeler declaration: delete the app.bsky.labeler.service record
 * then re-declare it. skyware's `recreate` command ("recommended if labels are
 * not showing up") — the delete+create commit pair is the strong firehose signal
 * that makes the AppView ingester (Vortex) drop any stale/backed-off subscription
 * and reconnect fresh (replaying from cursor 0).
 *
 *   BSKY_IDENTIFIER=... BSKY_APP_PASSWORD=... npx tsx src/recreate.ts
 */
import { deleteLabelerDeclaration, declareLabeler } from "@skyware/labeler/scripts";
import { LABEL_DEFINITIONS } from "./labelDefs.js";

async function main(): Promise<void> {
	const identifier = process.env.BSKY_IDENTIFIER;
	const password = process.env.BSKY_APP_PASSWORD;
	const pds = process.env.PDS_URL ?? "https://bsky.social";
	if (!identifier || !password) throw new Error("set BSKY_IDENTIFIER and BSKY_APP_PASSWORD");

	console.log("deleting labeler declaration...");
	await deleteLabelerDeclaration({ identifier, password, pds });
	console.log("re-declaring labeler declaration...");
	await declareLabeler({ identifier, password, pds }, LABEL_DEFINITIONS as never, true);
	console.log("recreated. labels:", LABEL_DEFINITIONS.map((d) => d.identifier).join(", "));
}

main().catch((err) => {
	console.error("recreate failed:", err instanceof Error ? err.message : err);
	process.exit(1);
});
