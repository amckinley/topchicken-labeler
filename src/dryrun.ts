/** Dry-run: build the history from live feeds and print it. No labels written. */
import { AtpAgent } from "@atproto/api";
import { buildHistory } from "./crownings.js";

async function main() {
	const agent = new AtpAgent({ service: process.env.PDS_URL ?? "https://bsky.social" });
	if (process.env.BSKY_IDENTIFIER && process.env.BSKY_APP_PASSWORD) {
		await agent.login({
			identifier: process.env.BSKY_IDENTIFIER,
			password: process.env.BSKY_APP_PASSWORD,
		});
	}
	const h = await buildHistory(agent);
	console.log(`crownings: ${h.crownings.length}, alumni: ${h.alumni.size}`);
	console.log(`current: @${h.current?.handle} (${h.current?.did}) since ${h.current?.ts}`);
	console.log("alumni (best likes):");
	for (const [did, info] of [...h.alumni].sort((a, b) => b[1].bestLikes - a[1].bestLikes)) {
		console.log(`  ${String(info.bestLikes).padStart(5)}  @${info.handle}  ${did}`);
	}
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
