/**
 * What a bundle was when it was installed, so that "is there a newer one" can be asked at all.
 *
 * Installing used to leave no trace of where the files came from. The directory holds a manifest,
 * and a manifest holds whatever the author wrote in it — which for most of the catalogue is either
 * nothing or a version that never moves. So the app could show a bundle beside a registry entry
 * offering the same bundle and have no way to tell whether they were the same bundle.
 *
 * This is deliberately a ledger rather than a file inside each directory. A skill collection has no
 * directory of its own — `moveInto` flattens its skills in among the loose ones — so a per-bundle
 * file would work for two of the three kinds and need a second mechanism for the third. One file
 * that answers for all three is the smaller thing.
 *
 * The ledger is not authority. What is on disk is: an entry here whose directory has been deleted
 * by hand is stale, and every reader joins on what the scan found rather than trusting this. It
 * only ever adds facts to bundles that are already there.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { plumeHome } from "../session/store.ts";
import type { InstallRecord } from "./install-record.ts";

/*
 * The record itself and the comparison live next door, in a file that imports nothing.
 *
 * They have to: the renderer is where an installed bundle meets the entry a registry is offering,
 * so that is where `isOutdated` runs, and anything reachable from a browser bundle may not touch
 * `node:fs`. Re-exported here so that code with a filesystem gets both halves from one import.
 */
export { isOutdated, type InstallRecord } from "./install-record.ts";

function ledgerPath(): string {
	return join(plumeHome(), "installs.json");
}

/**
 * Every install we have a record of, keyed by id.
 *
 * A missing or corrupt file is an empty ledger rather than an error. Nothing here is load-bearing:
 * without it every bundle simply reports an unknown origin, which is the same state as a bundle
 * installed before this existed, and the plugins page has to handle that anyway.
 */
export async function readInstalls(): Promise<Record<string, InstallRecord>> {
	const raw = await readFile(ledgerPath(), "utf8").catch(() => null);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, InstallRecord>;
	} catch {
		return {};
	}
}

/**
 * Write one record, leaving the rest alone.
 *
 * Read-modify-write, which is safe here because installs are driven by a person clicking a button
 * in one window: two of them landing between the read and the write would need two clicks inside
 * the same few milliseconds. Making it atomic would mean a lock file to clean up after crashes,
 * and the loss in the case it protects against is one bundle reporting an unknown origin.
 */
export async function recordInstall(record: InstallRecord): Promise<void> {
	const all = await readInstalls();
	all[record.id] = record;
	await save(all);
}

/** Forget a bundle, because it is no longer on disk. */
export async function forgetInstall(id: string): Promise<void> {
	const all = await readInstalls();
	if (!(id in all)) return;
	delete all[id];
	await save(all);
}

async function save(all: Record<string, InstallRecord>): Promise<void> {
	await mkdir(plumeHome(), { recursive: true });
	await writeFile(ledgerPath(), `${JSON.stringify(all, null, "\t")}\n`, "utf8");
}
