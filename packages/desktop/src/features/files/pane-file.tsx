/**
 * 这一格文件面板看着的那个文件，和顶上那排标签里它叫什么。
 *
 * 每个打开的文件是一格（`file`、`file:<id>`），各看各的——见 `store/openFile.ts`。面板正文、头上的
 * 名字和按钮都从这里问「我是哪一格」，不各自拼键。
 */

import { useDockScope, usePanelKind } from "../../app/session-scope.tsx";
import { baseName } from "../../lib/paths.ts";
import { fileSlot, openFileOf, useOpenFile, type OpenFile } from "../../store/openFile.ts";

/** 这一格在 `useOpenFile` 里的键。 */
export function usePaneSlot(): string {
	return fileSlot(useDockScope(), usePanelKind() ?? "file");
}

/** 这一格的文件里挑一样出来。 */
export function usePaneFile<T>(pick: (file: OpenFile) => T): T {
	const slot = usePaneSlot();
	return useOpenFile((state) => pick(openFileOf(state, slot)));
}

/** 标签上写文件名；点下去还在读的那一个也已经写它的名字。还没选文件时写面板自己的名字。 */
export function FileTabTitle({ scope, kind, fallback }: { scope: string; kind: string; fallback: string }) {
	const path = useOpenFile((state) => {
		const file = openFileOf(state, fileSlot(scope, kind));
		return file.opening ?? file.path;
	});
	return <>{path ? baseName(path) : fallback}</>;
}

/** 后开的那一格关掉：它看着的文件一起放下。 */
export function closeFile(scope: string, instance: string): void {
	useOpenFile.getState().drop(fileSlot(scope, `file:${instance}`));
}
