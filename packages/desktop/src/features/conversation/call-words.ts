/**
 * 一次调用、一段调用在行上用的那几个词和数，纯数据。
 *
 * 从 `runs.tsx` 拆出来：`WorkStep` 要用它们，而 `runs.tsx` 经文件预览连回转录，从 `WorkStep` 引它就是
 * 一条新的循环依赖。
 */

import type { AssistantContent } from "@plume/core";
import type { ToolRun as ToolRunState } from "../../store/index.ts";
import { baseName } from "../../lib/paths.ts";
import { describeCall, describeRun } from "../../lib/tool-kinds.ts";
import type { Call } from "./grouping.ts";

/** What a set of calls did, in words — the same sentence a run line and a turn line use. */
export function describeCalls(calls: Call[]): string {
  return describeRun(calls.map(({ block }) => ({ toolName: block.name, subject: subjectOf(block) })));
}

/** core 给这几个探索工具加了一句给人看的 `description`。bash 的那句走 `summarize`，到这里已经在 `summary` 里。 */
const DESCRIBED = new Set(["read", "grep", "glob", "ls"]);

/**
 * 一次调用在行上怎么说：模型写了一句给人看的说明就用它，没写就退回「读取文件 a.ts」。
 *
 * grep、glob 的 `description` 还兜着另一种用法：没给 `pattern` 时，模型常把要搜的式子写在那里（core 的
 * `extractGrepPattern`）。那时它是一条正则、不是一句话，照旧说成「搜索内容 …」。
 */
export function describeOne(block: Extract<AssistantContent, { type: "toolCall" }>, summary?: string): string {
  const { description, pattern } = (block.arguments ?? {}) as { description?: unknown; pattern?: unknown };
  const said = typeof description === "string" ? description.trim() : "";
  const asPattern = (block.name === "grep" || block.name === "glob") && typeof pattern !== "string";
  if (said && DESCRIBED.has(block.name) && !asPattern) return said;
  return describeCall(block.name, summary, subjectOf(block));
}

/** The file a call is about, when it is about one — the part worth naming in a summary. */
export function subjectOf(block: Extract<AssistantContent, { type: "toolCall" }>): string | undefined {
  const { path, url } = (block.arguments ?? {}) as { path?: unknown; url?: unknown };
  // Either separator: a Windows path split on "/" alone came back whole, drive letter and all.
  if (typeof path === "string") return baseName(path);
  // 打开的网页：本地文件报文件名，网站报主机名——整串地址放在一行摘要里只会被截掉。
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const name = baseName(parsed.pathname);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? (/\.html?$/i.test(name) ? name : parsed.host) : name || undefined;
  } catch {
    return baseName(url) || undefined;
  }
}

export function diffOf(run: ToolRunState | undefined, key: "added" | "removed"): number {
  const value = (run?.result?.details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" ? value : 0;
}
