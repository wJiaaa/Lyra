import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { computeDiff, formatDiff, plumeHome, readFileChange, type Message, type RecordedChange, type DiffHunk } from "@plume/core";
export interface DeliveryFile { path: string; added: number; removed: number; hunks: DiffHunk[]; changeIds: string[]; canUndo: boolean }
export interface TurnDelivery { files: DeliveryFile[]; commands: { command: string; status: string; output: string }[]; serviceJobIds: string[]; warnings: string[]; reportPath: string | null }
export function deliveryMessages(messages: Message[], timestamp: number): Message[] {
	const end = messages.findIndex((message) => message.role === "assistant" && message.timestamp === timestamp);
	if (end < 0) throw new Error("找不到对应的回答");
	let start = end - 1;
	while (start >= 0) {
		const message = messages[start];
		if (message.role === "user" && !message.synthetic) break;
		start--;
	}
	return messages.slice(Math.max(0, start), end + 1);
}
export async function collectDelivery(sessionId: string, cwd: string, messages: Message[], timestamp: number): Promise<TurnDelivery> {
	const value: TurnDelivery = { files: [], commands: [], serviceJobIds: [], warnings: [], reportPath: null };
	const groups = new Map<string, RecordedChange[]>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const detail = message.details;
		if (!detail || typeof detail !== "object") continue;
		if (!message.isError && "kind" in detail && detail.kind === "bash_background" && "id" in detail && typeof detail.id === "string") value.serviceJobIds.push(detail.id);
		const ids = "changeIds" in detail && Array.isArray(detail.changeIds) ? detail.changeIds.filter((id): id is string => typeof id === "string") : [];
		if (!message.isError && "changeId" in detail && typeof detail.changeId === "string") ids.push(detail.changeId);
		for (const id of ids) {
			try { const change = await readFileChange(sessionId, id); const group = groups.get(change.path) ?? []; group.push(change); groups.set(change.path, group); }
			catch (error) { value.warnings.push(`变更快照不可用：${String(error)}`); }
		}
		if ("changeWarning" in detail && typeof detail.changeWarning === "string") value.warnings.push(detail.changeWarning);
		if ("command" in detail && typeof detail.command === "string") {
			const status = "exitCode" in detail && typeof detail.exitCode === "number" ? `exit ${detail.exitCode}` : message.isError ? "失败或中断" : "已启动";
			value.commands.push({ command: detail.command, status, output: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") });
		}
	}
	for (const [path, changes] of groups) {
		const first = changes[0], last = changes[changes.length - 1];
		const diff = computeDiff(first.before ?? "", last.after ?? "");
		if (!diff.added && !diff.removed) continue;
		const contiguous = changes.every((change, index) => (!index || change.before === changes[index - 1].after) && change.source !== "command");
		let canUndo = false;
		if (contiguous) { try { canUndo = await readFile(path, "utf8") === last.after; } catch { canUndo = false; } }
		value.files.push({ path, added: diff.added, removed: diff.removed, hunks: diff.hunks, changeIds: changes.map((change) => change.id), canUndo });
	}
	const engineering = value.files.length > 0 || value.warnings.length > 0 || value.commands.some((entry) => /(?:^|[\s/])(?:test|check|lint|typecheck|pytest|jest|vitest|cargo|go)(?:[\s:]|$)/i.test(entry.command));
	if (!engineering) return value;
	const request = messages.filter((message) => message.role === "user" && !message.synthetic).flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n\n");
	const answer = messages.filter((message) => message.role === "assistant" && message.stopReason !== "toolUse").flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n\n");
	const report = [`# 本轮实现与验证记录`, `时间：${new Date(timestamp).toISOString()}`, `项目：${cwd}`, `## 用户需求`, request, `## Agent 交付说明`, answer,
		`## 实际文件变更`, ...value.files.map((file) => `- ${relative(cwd, file.path)}：+${file.added} −${file.removed}`),
		`## 命令与验证证据`, ...(value.commands.length ? value.commands.map((entry) => `### ${entry.status}\n\n~~~sh\n${entry.command}\n~~~\n\n~~~text\n${entry.output}\n~~~`) : ["本轮没有执行验证命令。"]),
		...(value.warnings.length ? ["## 未覆盖的记录", ...value.warnings] : []),
		`## 文件差异`, ...value.files.map((file) => `~~~diff\n${formatDiff({ added: file.added, removed: file.removed, hunks: file.hunks }, file.path, Infinity)}\n~~~`),
	].join("\n\n");
	// Session ids are supplied by the trusted transcript, but still cannot become path segments.
	const dir = join(plumeHome(), "scratch", encodeURIComponent(sessionId)); await mkdir(dir, { recursive: true });
	value.reportPath = join(dir, `delivery-${timestamp}.md`); await writeFile(value.reportPath, report, "utf8");
	return value;
}
