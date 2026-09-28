import { mergeFilePanelChanges, type FilePanelState, type FilePanelVersion } from "../../shared/file-panel-state.ts";
import { basePanelKind } from "../lib/panel-instance.ts";
import { baseName } from "../lib/paths.ts";
import { bridge } from "../services/index.ts";
import { fileSlot, openFileOf, useOpenFile, type OpenFile } from "./openFile.ts";

/**
 * One pane's file, in the shape the main process checks.
 *
 * A pane shows one file now, so `tabs` is that file or nothing. The shape stays: the main process
 * validates and merges it, and a list of one is a list it already understands.
 */
export function filePanelSnapshot(slot: string): FilePanelState {
	const { files, wrap, showSource } = useOpenFile.getState();
	const open = openFileOf({ files }, slot);
	const path = open.opening ?? open.path;
	const name = path === open.path && open.name ? open.name : path ? baseName(path) : null;
	return { path, tabs: path && name ? [{ path, name }] : [], wrap, showSource };
}

const setSlot = (slot: string, next: Partial<OpenFile>) =>
	useOpenFile.setState((state) => ({ files: { ...state.files, [slot]: { ...openFileOf(state, slot), ...next } } }));

/** Load through the normal file boundary rather than trusting transferred contents or permissions. */
export async function applyFilePanelState(slot: string, state: FilePanelState, update = (apply: () => void) => apply()): Promise<void> {
	const current = openFileOf(useOpenFile.getState(), slot);
	const tab = state.tabs.find((entry) => entry.path === state.path);
	const needsRead = state.path !== current.path || !current.contents;
	update(() => {
		useOpenFile.setState({ wrap: state.wrap, showSource: state.showSource });
		if (tab && needsRead) setSlot(slot, { opening: tab.path, loading: true });
		if (!tab) setSlot(slot, { path: null, name: null, contents: null, opening: null, loading: false });
	});
	if (!tab || !needsRead) return;
	try {
		const contents = await bridge.files.read(tab.path);
		if (openFileOf(useOpenFile.getState(), slot).opening !== tab.path) return;
		update(() => setSlot(slot, { path: tab.path, name: tab.name, contents, opening: null, loading: false }));
	} catch (error) {
		if (openFileOf(useOpenFile.getState(), slot).opening === tab.path) update(() => setSlot(slot, { opening: null, loading: false }));
		throw error;
	}
}

let flushPending: () => Promise<void> = async () => {};

/** The return button waits for the last change's acknowledgement before requesting its handoff. */
export function flushFilePanelState(): Promise<void> {
	return flushPending();
}

export function watchFilePanelState(onError: (error: unknown) => void): () => void {
	if (!bridge.windows?.onFilePanelState) return () => {};
	const panelKind = bridge.bootWindow?.kind === "panel" ? bridge.bootWindow.panelKind : undefined;
	const detached = !!panelKind && basePanelKind(panelKind) === "file";
	// A panel window has no screen and holds this one pane — see `fileSlot`.
	const slot = fileSlot(null, panelKind ?? "file");
	let live = true;
	let applying = false;
	let confirmed: FilePanelVersion | null = null;
	let pending: Promise<void> | null = null;
	const quietly = (apply: () => void) => {
		applying = true;
		try { apply(); } finally { applying = false; }
	};
	const apply = (state: FilePanelState) => applyFilePanelState(slot, state, quietly).catch(onError);
	const same = (a: FilePanelState, b: FilePanelState) => JSON.stringify(a) === JSON.stringify(b);
	const sync = (): Promise<void> => {
		if (pending) return pending;
		pending = (async () => {
			while (confirmed) {
				if (!live) break;
				const base = confirmed;
				const state = filePanelSnapshot(slot);
				if (same(state, base.state)) break;
				const reply = await bridge.windows.filePanelState({ version: base.version, state });
				if (!reply) throw new Error("File panel state handoff was rejected");
				if (!live) break;
				// A newer open request can overtake an edit acknowledgement. Rebase only our delta.
				if (confirmed.version > reply.version) continue;
				const accepted = reply.version === base.version + 1 && same(reply.state, state);
				const next = mergeFilePanelChanges(accepted ? state : base.state, filePanelSnapshot(slot), reply.state);
				confirmed = reply;
				await apply(next);
			}
		})().finally(() => { pending = null; });
		return pending;
	};
	const receive = async (input: FilePanelVersion & { previous?: FilePanelState }) => {
		if (!live) return;
		if (!detached) {
			/*
			 * The popped-out pane is not in this window, so there is no file here to follow. Only how
			 * to read is shared — wrap and source view are one setting across every file pane.
			 */
			const { previous, state } = input;
			if (previous) useOpenFile.setState((current) => ({
				wrap: current.wrap === previous.wrap ? state.wrap : current.wrap,
				showSource: current.showSource === previous.showSource ? state.showSource : current.showSource,
			}));
			return;
		}
		if (confirmed && input.version <= confirmed.version) return;
		const next = confirmed ? mergeFilePanelChanges(confirmed.state, filePanelSnapshot(slot), input.state) : input.state;
		confirmed = input;
		await apply(next);
		if (live) await sync();
	};
	const stopEvent = bridge.windows.onFilePanelState((input) => { void receive(input).catch(onError); });
	const stopStore = detached ? useOpenFile.subscribe(() => {
		if (!applying && confirmed) void sync().catch(onError);
	}) : () => {};
	if (detached) {
		flushPending = sync;
		void bridge.windows.filePanelState().then((state) => state && receive(state)).catch(onError);
	}
	return () => {
		live = false;
		stopEvent();
		stopStore();
		if (detached) flushPending = async () => {};
	};
}
