import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { plumeHome, readTrajectory, type SessionStorage } from "@plume/core";
import { entryKey, SOURCE_LABEL, STATUS_LABEL } from "@plume/core/trajectory-view";
import { grantArtifactRead } from "./readable-artifacts.ts";

/** Export only an authoritative session projection; IPC never supplies a file path or content. */
export async function exportTrajectory(store: SessionStorage, projectId: string, sessionId: string, format: "json" | "md" | "output", selection?: { id?: string; correlationId?: string }, running = false): Promise<string> {
	if (format !== "json" && format !== "md" && format !== "output") throw new Error("不支持的轨迹格式");
	const meta = (await store.listSessions()).find(item => item.id === sessionId && item.projectId === projectId);
	if (!meta) throw new Error("会话不存在");
	const all = await readTrajectory(store, meta.projectId, meta.id, running);
	const entries = selection ? all.filter(entry => selection.id ? entryKey(entry) === selection.id : selection.correlationId && entry.correlationId === selection.correlationId) : all;
	if (selection && !entries.length) throw new Error("这条记录尚未落盘或已被撤回");
	if (format === "output") {
		const data = entries.find(entry => entry.metadata && typeof entry.metadata === "object" && "outputPath" in entry.metadata)?.metadata;
		if (!data || typeof data !== "object" || !("outputPath" in data) || typeof data.outputPath !== "string") throw new Error("这条历史记录没有保存原始输出文件");
		const root = await realpath(join(plumeHome(), "scratch", meta.id, "tool-output"));
		const path = await realpath(data.outputPath);
		const tail = relative(root, path);
		if (!tail || tail === ".." || tail.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(tail)) throw new Error("输出文件不属于当前会话");
		grantArtifactRead(path); return path;
	}
	const text = format === "json" ? JSON.stringify({ version: 1, session: meta, entries }, null, 2) : [
		`# ${meta.title}\n\n会话：${meta.id}\n项目：${meta.cwd}`,
		...entries.map(entry => {
			const content = [entry.command, entry.detail, entry.output].filter((part, index, values) => part && values.indexOf(part) === index).join("\n\n");
			// Longer than any source fence, so copied commands cannot close the export's code block.
			const fence = "`".repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), match => match[0].length + 1)));
			return `## #${entry.seq} ${SOURCE_LABEL[entry.source]} · ${entry.summary}\n\n${entry.status ? STATUS_LABEL[entry.status] : ""} · ${new Date(entry.ts).toISOString()}${entry.durationMs === undefined ? "" : ` · ${entry.durationMs} ms`}\n\n${fence}text\n${content}\n${fence}\n\n${entry.metadata === undefined ? "" : `详情：\n\n${JSON.stringify(entry.metadata, null, 2)}`}`;
		}),
	].join("\n\n");
	const directory = await mkdtemp(join(tmpdir(), "plume-trajectory-"));
	const path = join(directory, `trajectory.${format}`);
	await writeFile(path, text, { mode: 0o600 });
	grantArtifactRead(path);
	return path;
}
