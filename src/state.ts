/**
 * Tiny persisted state: who currently holds the `top-chicken` crown.
 *
 * We need the previous holder's DID to negate their `top-chicken` label when the
 * crown moves. The label DB itself is the source of truth for what's been emitted,
 * but reading "current holder" back out of it is awkward, so we keep a small JSON
 * sidecar on the same volume.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface HolderState {
	/** DID of the account currently wearing the crown — the poller's dedupe key. */
	currentHolderDid: string | null;
	/** Informational: timestamp of the crowning that put this holder on the throne. */
	currentSince: string | null;
}

const EMPTY: HolderState = { currentHolderDid: null, currentSince: null };

export async function readState(path: string): Promise<HolderState> {
	try {
		const raw = await readFile(path, "utf8");
		return { ...EMPTY, ...JSON.parse(raw) };
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
		throw err;
	}
}

export async function writeState(path: string, state: HolderState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// Write to a temp file then atomically rename, so a crash mid-write can't leave
	// a truncated JSON file that makes every subsequent readState throw and wedge
	// the poller.
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(state, null, 2));
	await rename(tmp, path);
}
