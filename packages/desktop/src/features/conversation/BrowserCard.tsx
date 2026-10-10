/**
 * 对话里的那张浏览器卡片：agent 打开过的页面在对话里留下的一行——叫什么、在哪，和一颗「打开」。
 *
 * 页面本身在侧栏里：`browser_open` 打开时面板会展开（见主进程的 `openBrowser`）。所以这里只记一笔、
 * 给一个回去的入口，不再放页面的缩略图——一张大图长得和 `preview` 嵌在对话里的网页一模一样，两种
 * 东西就分不清了。面板关掉、标签关掉、应用重启之后，回到那个页面靠的也是这一行。
 *
 * 一张卡代表一个标签页，从它的一次 `browser_open` 起，到同一个标签页下一次 `browser_open` 之前。
 * 中间 agent 每点一下、输一段，卡片上的图、标题和地址就换成最新的——隔着几句话也一样，因为卡片说的
 * 是这个标签页，不是它恰好挂在下面的那一段工具调用。
 *
 * 同一轮里同一个页面只留最后一张，哪怕开在不同的标签页里：agent 改一次页面就开个新标签再看一遍，
 * 一轮下来是一列几乎一样的大图，成品反倒淹在里面（见 `BrowserCards`）。
 *
 * 放在对话这一侧、只经 `bridge` 跟浏览器说话，不从浏览器那个域拿东西：那边的状态模块连着 dock，
 * dock 的内置面板又连回对话，从这里引过去就是一个环（`pnpm arch`）。卡片要的也确实只有两件事——
 * 标签页还在不在、打开它——都问主进程就够了，它本来就是标签页的事实来源。
 */

import { Globe, PanelRightOpen } from "../../ui/icons/index.ts";
import type { BrowserResultDetails } from "../../../shared/browser.ts";
import { useScopedFromToolRuns, useScopedSessionId } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp, type ToolRun } from "../../store/index.ts";
import type { TurnBlock } from "./grouping.ts";
import { Button } from "../../ui/primitives/Button.tsx";

interface CardView {
	status: ToolRun["status"];
	tabId: string;
	url: string;
	title: string;
}

/**
 * 一张卡该写什么：按调用顺序读工具记录，从自己那次 `browser_open` 读到同一标签页的下一次为止，
 * 每一样取最新的。
 *
 * 返回字符串，好让选择器按值比较——工具输出每流进来一行，整张记录表就换一份，每次返回一个新对象
 * 会让每张卡片跟着重画一遍。
 */
function viewOf(runs: Record<string, ToolRun>, callId: string): string {
	const entries = Object.values(runs);
	const start = entries.findIndex((run) => run.toolCallId === callId);
	const first = entries[start];
	if (!first) return "";
	const opened = first.result?.details as BrowserResultDetails | undefined;
	const view: CardView = {
		status: first.status,
		tabId: opened?.tabId ?? "",
		url: opened?.url || (typeof first.args.url === "string" ? first.args.url : ""),
		title: opened?.title ?? "",
	};
	if (view.tabId) {
		for (const run of entries.slice(start + 1)) {
			const details = run.result?.details as BrowserResultDetails | undefined;
			if (details?.kind !== "browser" || details.tabId !== view.tabId) continue;
			if (details.opened) break;
			if (details.url) view.url = details.url;
			if (details.title) view.title = details.title;
		}
	}
	return JSON.stringify(view);
}

/** 只给网页地址写主机名。本地预览的地址里是一串会话 id，写出来只是噪音。 */
function hostOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : "";
	} catch {
		return "";
	}
}

/**
 * 两次打开是不是同一个页面：去掉 `?` 和 `#` 的地址。
 *
 * agent 绕缓存会拼 `?v=2`、`?v=3`，那是同一页的第几版，不是另一页。本地文件的副本按源文件固定地址
 * （`electron/local-page.ts`），所以同一个文件开几次也落在这里。
 */
function pageOf(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return url;
	}
}

/** 一块过程里的 `browser_open`，按调用顺序。 */
export function pageOpens(block: TurnBlock): string[] {
	return block.runs.flatMap((run) => (run.kind === "tools" ? run.calls.filter(({ block: call }) => call.name === "browser_open").map(({ block: call }) => call.id) : []));
}

/** 每一块之后、同一轮里还会有的 `browser_open`——卡片据此知道自己是不是这一页的最后一张。 */
export function laterPageOpens(blocks: TurnBlock[]): string[][] {
	const later: string[][] = [];
	let tail: string[] = [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i + 1]?.turn !== blocks[i]!.turn) tail = [];
		later[i] = tail;
		// 只有过程块画卡片（`Conversation`），别处的打开没有卡片可以接替前面那张。
		if (blocks[i]!.kind === "process") tail = [...pageOpens(blocks[i]!), ...tail];
	}
	return later;
}

const NONE: string[] = [];

/**
 * 一段过程里打开过的页面，同一轮里同一个页面只留最后一张。
 *
 * 「同一个」两种认法：同一个标签页（导航了两次，前一次被后一次盖掉），或同一个地址（见 `pageOf`）。
 * 后面那张可能在这一轮更靠后的一段里，所以除了本段的 `calls` 还要看 `later`；没开成的那次不算，
 * 否则一次失败的重开会把前面开成的那张也带走。
 */
export function BrowserCards({ calls, later = NONE }: { calls: string[]; later?: string[] }) {
	// This screen's records: the live slot's are the focused conversation's, where none of these calls is.
	const keys = useScopedFromToolRuns((toolRuns) => [...calls, ...later].map((id) => {
		const run = toolRuns[id];
		if (run?.status === "error") return "\t";
		const details = run?.result?.details as BrowserResultDetails | undefined;
		const url = details?.url || (typeof run?.args.url === "string" ? run.args.url : "");
		return `${details?.tabId ?? ""}\t${url ? pageOf(url) : ""}`;
	}).join("\n"));
	const rows = keys.split("\n").map((row) => row.split("\t"));
	const shown = calls.filter((_, i) => {
		const [tab, page] = rows[i]!;
		return !rows.slice(i + 1).some(([nextTab, nextPage]) => (tab && nextTab === tab) || (page && nextPage === page));
	});
	if (shown.length === 0) return null;
	return (
		<div className="flex flex-col gap-2.5">
			{shown.map((id) => <BrowserCard key={id} callId={id} />)}
		</div>
	);
}

function BrowserCard({ callId }: { callId: string }) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const raw = useScopedFromToolRuns((toolRuns) => viewOf(toolRuns, callId));
	if (!raw) return null;
	const view = JSON.parse(raw) as CardView;
	// 没打开的页面不留卡片：失败本身已经写在工具那一行里了。
	if (view.status === "error") return null;
	const opening = view.status === "running" && !view.tabId;
	const host = hostOf(view.url);
	const title = view.title || host || view.url;

	/*
	 * 标签页还在就选中它，不在了（关掉了、应用重启过）就按地址重开一个。「还在」只算这个对话自己的：
	 * 同一个 id 落在别的对话名下，那是别人的页面。
	 *
	 * 面板由主进程那一侧展开：这里发出去的命令是人按的，带着 `reveal`——跟地址栏、预览链接是同一条路。
	 */
	const open = async () => {
		try {
			const { tabs } = await bridge.browser.state();
			const alive = tabs.some((entry) => entry.id === view.tabId && (entry.sessionId ?? null) === (sessionId ?? null));
			if (alive) await bridge.browser.command({ type: "select", id: view.tabId });
			else if (view.url) await bridge.browser.command({ type: "open", url: view.url, sessionId, newTab: true });
		} catch (error) {
			useApp.getState().notify(String(error), "error");
		}
	};

	return (
		<section data-browser-card aria-label={title} className="w-full max-w-[420px] rounded-xl border border-line bg-card/30 text-label">
			<div className="flex items-center gap-2.5 py-1.5 pr-1.5 pl-3" data-browser-card-row>
				<Globe size={15} strokeWidth={1.7} className={`shrink-0 text-ink-muted ${opening ? "ly-pulse" : ""}`} />
				<p className="min-w-0 flex-1 truncate" data-ly-tip={view.url || undefined}>
					<span className="font-medium text-ink">{title}</span>
					<span className="text-caption text-ink-faint">
						{" · "}{host && host !== title ? `${host} · ` : ""}{opening ? t("browser.card.opening") : t("browser.card.opened")}
					</span>
				</p>
				{!opening && (
					<Button size="sm" variant="subtle" icon={<PanelRightOpen size={14} />} label={t("browser.card.show")} onClick={() => void open()}>
						{t("common.open")}
					</Button>
				)}
			</div>
		</section>
	);
}
