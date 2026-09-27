import { translate } from "../../i18n/translate.ts";
import type { Language } from "@codemirror/language";
import { Check, Copy, Play, WrapText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { highlightGeneration, loadFenceLanguage, onHighlightChange, sharedHighlightStyle, tokenize } from "../../lib/code/highlight.ts";
import { iconColour, lookFor } from "../../ui/fileIcon.tsx";
import { useSide, openScopedPanel } from "../dock/index.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";

/**
 * Fences that are commands rather than code.
 *
 * A Python snippet in a reply is an illustration; a shell line is an instruction, and the gap
 * between reading it and running it is a trip to another window and a paste. Only these get the
 * button — offering to "run" a TypeScript block would be offering something that cannot happen.
 */
const SHELL = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

/** 围栏语言名到扩展名，只为给标题栏挑一个和文件树同款的图标；不在表里的按原样当扩展名。 */
const LANG_EXTENSION: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	python: "py",
	rust: "rs",
	golang: "go",
	ruby: "rb",
	kotlin: "kt",
	csharp: "cs",
	"c++": "cpp",
	markdown: "md",
	shell: "sh",
	console: "sh",
	terminal: "sh",
	text: "txt",
	plaintext: "txt",
};

/**
 * 超过这么多字符就不高亮了。
 *
 * 见下面 `tokens` 里的注释——这个数是照着「一帧以内跑得完」量出来的。
 */
const HIGHLIGHT_LIMIT = 60_000;

/** Comment lines and prompt markers are for reading; the shell should not receive them. */
function commandFrom(code: string): string {
	return code
		.split("\n")
		.map((line) => line.replace(/^\s*[$>]\s+/, "").trimEnd())
		.filter((line) => line.trim() && !line.trim().startsWith("#"))
		.join("\n")
		.trim();
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
	// The screen this block is on, by the key its dock uses: its session id, or `@draft`.
	const screen = useScopedSessionId() ?? "@draft";
	const [copied, setCopied] = useState(false);
	const [wrap, setWrap] = useState(false);
	const label = lang.toLowerCase() || "text";
	const look = lookFor(`code.${LANG_EXTENSION[label] ?? label}`, false);
	const [language, setLanguage] = useState<Language | null>(null);

	/*
	 * Grammar fetched per language, colouring recomputed per edit.
	 *
	 * Grammars are dynamic imports — a transcript that only ever shows TypeScript should not pay
	 * for the Python and SQL parsers as well. While one is in flight the block renders as plain
	 * text, which is also what a reply still streaming its fence shows.
	 */
	useEffect(() => {
		if (!lang) return;
		let cancelled = false;
		void loadFenceLanguage(lang).then((result) => {
			if (!cancelled) setLanguage(result);
		});
		return () => {
			cancelled = true;
		};
	}, [lang]);

	/*
	 * 换了代码主题就得重算，因为类名整套都换了。
	 *
	 * token 和它的类名是一起算出来存进 `useMemo` 的，而换主题会重新生成一整套类名——存着的那份
	 * 于是指向一批不存在的规则，整块代码掉回默认字色。依赖里带上代数，换代就重算。
	 */
	const generation = useSyncExternalStore(onHighlightChange, highlightGeneration, highlightGeneration);

	const tokens = useMemo(() => {
		if (!language) return null;
		/*
		 * 太长的块不高亮，直接给纯文本。
		 *
		 * `tokenize` 是同步的，而它前面没有任何上限。本机一个会话里有一条用户消息 233KB、1087 行，
		 * 整段是一个代码围栏——打开那个会话时主线程被占死 **2.3 秒**，鼠标转圈，而那个会话一共只有
		 * 34 条消息。相比之下 382 条消息、25MB 的会话只卡 195ms：贵的从来不是条数或文件大小，是
		 * 单块文本的长度。
		 *
		 * 60KB 这个数是量出来的，不是拍的：低于它的块在这台机器上都在一帧以内跑完；而真正会越过它的
		 * 内容——整个文件粘进来、几千行日志——本来也不是拿来逐行读的，少了配色不影响它被翻阅和复制。
		 *
		 * `return null` 走的是这个组件本来就有的降级路径（半截围栏在流式输出中途也走它），所以文本
		 * 一个字都不会少，只是没有配色。
		 */
		if (code.length > HIGHLIGHT_LIMIT) return null;
		try {
			return tokenize(code, language, sharedHighlightStyle());
		} catch {
			// A half-written fence mid-stream is not a reason to lose the text.
			return null;
		}
		// oxlint-disable-next-line exhaustive-deps -- `generation` 不出现在函数体里，它就是「重算」的信号
	}, [code, language, generation]);

	return (
		<div className="ly-code-block" data-wrap={wrap || undefined}>
			<div className="ly-code-head">
				<look.Icon size={14} strokeWidth={1.9} className="shrink-0" style={{ color: iconColour(look) }} />
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{SHELL.has(label) && commandFrom(code) && (
					<CodeAction
						tip={translate("codeBlock.runInTerminal")}
						onClick={() => {
							// 这一屏的终端来接，不是焦点屏的——见 `pendingFor`。
							useSide.getState().runInTerminal(commandFrom(code), screen);
							// 叫一个终端来接这条命令。已经有的会被聚焦而不是再开一个。
							openScopedPanel("terminal", undefined, screen);
						}}
					>
						<Play size={14} strokeWidth={1.9} />
					</CodeAction>
				)}
				<CodeAction tip={translate("fileActions.wrap")} active={wrap} onClick={() => setWrap(!wrap)}>
					<WrapText size={14} strokeWidth={1.9} />
				</CodeAction>
				<CodeAction
					tip={translate("common.copy")}
					onClick={() => {
						void navigator.clipboard.writeText(code);
						setCopied(true);
						setTimeout(() => setCopied(false), 1400);
					}}
				>
					{copied ? <Check size={14} strokeWidth={2} className="text-ok" /> : <Copy size={14} strokeWidth={1.9} />}
				</CodeAction>
			</div>
			<pre>
				<code>
					{tokens
						? tokens.map((token, index) =>
								token.className ? (
									<span key={index} className={token.className}>
										{token.text}
									</span>
								) : (
									token.text
								),
							)
						: code}
				</code>
			</pre>
		</div>
	);
}

function CodeAction({ tip, active, onClick, children }: { tip: string; active?: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			data-ly-tip={tip}
			aria-label={tip}
			aria-pressed={active}
			onClick={onClick}
			className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-[var(--ly-t-quick)] hover:bg-ink/[0.06] hover:text-ink ${active ? "text-ink" : "text-ink-muted"}`}
		>
			{children}
		</button>
	);
}
