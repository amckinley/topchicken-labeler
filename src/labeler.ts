/**
 * Crown-transfer logic shared by the poller and the backfill script.
 *
 * `top-chicken` is single-holder: when the crown moves we negate it off the old
 * holder and create it on the new one. `top-chicken-alumni` is sticky: we only
 * ever add it (creating a duplicate is harmless — clients dedupe — but we guard
 * with the state file / alumni set to avoid noise).
 */
import { LabelerServer } from "@skyware/labeler";
import { LABEL_CURRENT, LABEL_ALUMNI } from "./config.js";

/**
 * Move the `top-chicken` crown to `newHolderDid`, negating it off `oldHolderDid`
 * (if any and different), and ensure the new holder also carries the sticky
 * `top-chicken-alumni` label.
 *
 * Returns the labels that were created/negated, for logging.
 */
export async function transferCrown(
	server: LabelerServer,
	oldHolderDid: string | null,
	newHolderDid: string,
): Promise<{ negated: string[]; created: string[] }> {
	const negated: string[] = [];
	const created: string[] = [];

	// 1. Negate the current label off the previous holder (account-level subject).
	if (oldHolderDid && oldHolderDid !== newHolderDid) {
		await server.createLabels({ uri: oldHolderDid }, { negate: [LABEL_CURRENT] });
		negated.push(`${LABEL_CURRENT}@${oldHolderDid}`);
	}

	// 2. Apply the current crown + the sticky alumni badge to the new holder.
	//    Always (re)create both, even on a same-holder re-coronation: re-applying
	//    is harmless (the label log is append-only and clients dedupe), and it makes
	//    backfill/recovery idempotent — a run whose label DB was lost but whose state
	//    file still points at the current holder will correctly repair the crown.
	const toCreate = [LABEL_CURRENT, LABEL_ALUMNI];
	await server.createLabels({ uri: newHolderDid }, { create: toCreate });
	created.push(...toCreate.map((v) => `${v}@${newHolderDid}`));

	return { negated, created };
}

/** Apply the sticky alumni badge to a DID (idempotent at the meme level). */
export async function grantAlumni(server: LabelerServer, did: string): Promise<void> {
	await server.createLabels({ uri: did }, { create: [LABEL_ALUMNI] });
}

/** Negate the `top-chicken` crown off a DID (no-op-safe if it wasn't set). */
export async function negateCurrent(server: LabelerServer, did: string): Promise<void> {
	await server.createLabels({ uri: did }, { negate: [LABEL_CURRENT] });
}
