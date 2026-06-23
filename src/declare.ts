/**
 * Declare (or update) this labeller's label definitions on its account.
 *
 * Run once after `npx @skyware/labeler setup`, and again whenever LABEL_DEFINITIONS
 * changes. This publishes the app.bsky.labeler.service record so clients show the
 * label names/descriptions instead of raw values.
 *
 *   BSKY_IDENTIFIER=<labeler handle/did> BSKY_APP_PASSWORD=<pw> npm run declare
 */
import { declareLabeler } from "@skyware/labeler/scripts";
import { LABEL_DEFINITIONS } from "./labelDefs.js";

async function main(): Promise<void> {
	const identifier = process.env.BSKY_IDENTIFIER;
	const password = process.env.BSKY_APP_PASSWORD;
	const pds = process.env.PDS_URL ?? "https://bsky.social";
	if (!identifier || !password) {
		throw new Error("set BSKY_IDENTIFIER and BSKY_APP_PASSWORD (the labeler account creds)");
	}

	console.log(`declaring ${LABEL_DEFINITIONS.length} label definitions for ${identifier}...`);
	// overwriteExisting=true so re-running keeps the declaration in sync with code.
	await declareLabeler({ identifier, password, pds }, LABEL_DEFINITIONS as never, true);
	console.log("done. labels:", LABEL_DEFINITIONS.map((d) => d.identifier).join(", "));
}

main().catch((err) => {
	console.error("declare failed:", err instanceof Error ? err.message : err);
	process.exit(1);
});
