import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, type RetryPolicy } from "./retry-policy.ts";
import { normalizeMaxConcurrentSubAgents } from "../runtime/dispatch-guard.ts";
import { normalizeSubAgentProfiles, type SubAgentProfile } from "./sub-agent-profiles.ts";
import { constants, copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/client.ts";
import { EMPTY_HOOKS_CONFIG, normalizeHooksConfig, type HooksConfig } from "../hooks/config.ts";
import { plumeHome } from "../session/store.ts";
import type { ModelConfig, ProviderConfig, ThinkingLevel } from "../types.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import { withoutBom } from "../utils/bom.ts";
import { isPlaceholder, looksSecret } from "../mcp/placeholders.ts";
import { keepSecrets, putSecrets, secret } from "./vault.ts";

/** How much the agent may do without stopping to ask. */
export type PermissionMode =
	/** Ask before every mutating tool. */
	| "ask"
	/** Ask only for commands that are not recognised as read-only. */
	| "auto"
	/** Never ask. */
	| "full";

/** The language used by Plume's own interface. */
export type UiLocale = "system" | "zh-CN" | "en";

export const UI_LOCALES = ["system", "zh-CN", "en"] as const satisfies readonly UiLocale[];

function normalizeUiLocale(value: unknown): UiLocale {
	if (typeof value !== "string") return "system";
	return UI_LOCALES.find((locale) => locale === value) ?? "system";
}

export interface ProjectEntry {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	/**
	 * Every source folder this project is made of, `path` first.
	 *
	 * A project used to be one directory, and for most it still is — `path` remains the one the
	 * session runs in, the one git reads, the one a new conversation opens under. The extra folders
	 * are the rest of the same piece of work: the API repo beside the app repo, the design tokens
	 * checked out one level up. Naming them is what makes reading across them ordinary instead of
	 * a prompt per file (see `projectRootsFor`).
	 *
	 * Optional, and absent means `[path]`. Every settings file written before this existed says
	 * nothing here and must keep meaning exactly what it meant — so the reader is `projectFolders`
	 * rather than the field, everywhere.
	 */
	folders?: string[];
}

/** Everything the appearance page controls. Applied as CSS variables at runtime. */
export interface AppearanceSettings {
	theme: "system" | "light" | "dark";
	/** Accent colour, shared by both schemes. */
	accent: string;
	lightBackground: string;
	lightForeground: string;
	darkBackground: string;
	darkForeground: string;
	uiFont: string;
	codeFont: string;
	/** Syntax highlighting theme for light mode. */
	codeLightTheme?: string;
	/** Syntax highlighting theme for dark mode. */
	codeDarkTheme?: string;
	uiFontSize: number;
	codeFontSize: number;
	/**
	 * How code is set, beyond which family it is in.
	 *
	 * A monospace face is only half of what makes code readable; the rest is how tightly it is
	 * packed. Line height is the difference between a diff you can scan and a wall. Tracking is the
	 * smaller of the two and the one people with a particular face in mind ask for first.
	 *
	 * Optional, so an existing settings file keeps the values it never had — the defaults below are
	 * what the app has been rendering all along.
	 *
	 * A multiplier, not pixels: it has to hold at every one of the font sizes above.
	 */
	codeLineHeight?: number;
	/** In `em`, so it tracks the font size rather than fighting it. */
	codeLetterSpacing?: number;
	/**
	 * 单反引号那一小块——`像这样`——的配色从哪儿来。
	 *
	 * 围栏代码块早就跟着语法主题走了，行内代码没有：它一直是界面自己的 `--color-card-hover` 打底、
	 * `--color-ink` 写字，也就是一块灰底黑字。而一段讲代码的回答里，分支名、提交号、文件路径全都
	 * 是行内代码——它们是这段话里最该一眼认出来的东西，却是最没有颜色的。
	 *
	 * 三条来源，不是三套颜色：
	 *
	 *   `app`     跟界面走，也就是它一直以来的样子。底色随背景和对比度一起动，任何主题下都成立。
	 *   `syntax`  跟语法高亮主题走。选了 Solarized，句子里那块也跟着暖起来，和它下面的代码块同源。
	 *   `custom`  下面那四个颜色。
	 *
	 * 默认是 `app`：装上就变个样子不是升级，是惊吓。
	 */
	inlineCode?: "app" | "syntax" | "custom";
	/**
	 * `custom` 时用的四个颜色，深浅各一套。
	 *
	 * 分两套而不是一套，和上面的 `lightBackground` / `darkBackground` 是同一个道理：一个在白底上
	 * 好看的底色到了深色主题上就是一块亮斑。跟随系统的人一天之内会经过两种主题，两边都得能看。
	 *
	 * 默认值取的是 `app` 模式此刻算出来的那两个色，所以从「跟界面」切到「自定义」的那一下画面
	 * 不跳——先原样接管，再由着人改。
	 */
	inlineCodeLightBg?: string;
	inlineCodeLightFg?: string;
	inlineCodeDarkBg?: string;
	inlineCodeDarkFg?: string;
	/**
	 * 给它描一圈边。
	 *
	 * 为的是「只要文字变色、不要底色」这一种配法——不少人就喜欢那样，把底色调成和页面一样，句子
	 * 里只剩一截彩色的字。那时候行内代码和正文之间没有任何界线，`git` 和它前面的「跑一下」会糊成
	 * 一个词。描边是这种配法的退路，所以是个开关而不是固定行为。
	 *
	 * 画成 inset 的阴影而不是 border，因为 border 会把它撑高一圈：开关一次，整段话的行距跟着动。
	 */
	inlineCodeBorder?: boolean;
	/** 0–100. Scales the distance between surface layers and text. */
	contrast: number;
	pointerCursor: boolean;
	reduceMotion: "system" | "on" | "off";
	/** Whether diffs are shown by colour or by leading +/- markers. */
	diffMarkers: "color" | "symbols";
	fontSmoothing: boolean;
	/**
	 * How much of a failed turn is shown in the transcript.
	 *
	 * `full` states the error where it happened, alongside the way to undo it. `compact` reduces it
	 * to a single line that opens on demand. The failures that dominate a long session are dropped
	 * sockets and provider hiccups — the wording is a stack of JSON nobody reads, and at full weight
	 * a morning's work reads as a wall of red for something that resolved itself on the retry.
	 */
	errorDetail?: "full" | "compact";
	/**
	 * How a turn's tool calls are laid out in the transcript.
	 *
	 * `collapsed` gathers the whole turn under one line that is there from the start, with every call
	 * on a row of its own beneath it. `expanded` is the earlier layout: no turn line while it runs,
	 * calls grouped into summary lines of bordered cards, and the turn folding away once it ends.
	 */
	callChain?: "expanded" | "collapsed";
	/**
	 * How a conversation's panels share its screen.
	 *
	 * `tabs` puts every open panel into one pane at the screen's right edge, one tab each, with only
	 * the current one showing. `split` is the dock as it always was: every panel a pane of its own,
	 * arranged by dragging.
	 */
	panelLayout?: "split" | "tabs";
	/**
	 * macOS 主窗口的毛玻璃：侧边栏透出系统材质。
	 *
	 * 可选，没写过的设置文件照旧是开着的。关掉时窗口和侧边栏回到不透明的主题色——材质叠在桌面上，
	 * 颜色跟着壁纸走，有人要的是一块颜色确定的底。
	 */
	vibrancy?: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
	/*
	 * 跟着系统走，而不是钉死深色。
	 *
	 * 主进程一侧一直是这个行为：`window.ts` 读不到设置时按 `nativeTheme.shouldUseDarkColors` 画启动
	 * 屏，而这里却把没选过主题的人一律归为深色。两边不一致的代价不是审美问题——系统是浅色的机器上，
	 * 启动屏按系统画成浅色，渲染进程一加载又被这行拽回深色，开机第一眼是一次闪烁。
	 *
	 * 只影响没表过态的人：`normalizeSettings` 是 `{ ...DEFAULT_APPEARANCE, ...parsed.appearance }`，
	 * 谁在设置里选过深色，选的就还在。
	 */
	theme: "system",
	accent: "#339CFF",
	// 浅色背景。菜单和输入框的浮层色由它往白混 80%，约 #fefefe，比页面亮一档。
	lightBackground: "#F8F8F8",
	// 前景色：浅色 neutral-800，深色 neutral-300。
	lightForeground: "#262626",
	darkBackground: "#171717",
	darkForeground: "#D4D4D4",
	/*
	 * 不打包字体：界面是 Tailwind 默认的系统字体栈，代码是系统等宽字体，
	 * 中文回退写在 `monospace` 前面，因为 Windows 的 Consolas 没有中文字形。
	 */
	uiFont: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
	codeFont:
		'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace',
	// Plume's own — see `plume-light` in `code-themes.ts`. It takes the app's background rather than
	// bringing one, so a fresh install looks like Plume and picking any other theme is a real choice.
	codeLightTheme: "plume-light",
	codeDarkTheme: "plume-dark",
	// 14 reads next to Mail / native Mac apps. 13 was a size down from that and looked slight.
	uiFontSize: 14,
	codeFontSize: 12,
	codeLineHeight: 1.6,
	codeLetterSpacing: 0,
	// 跟界面走，也就是行内代码一直以来的样子；见 `inlineCode`。
	inlineCode: "app",
	/*
	 * 这四个是 `app` 模式此刻算出来的颜色，抄成定值。
	 *
	 * 浅色的底是 `--color-ink` 5% 压在白底上，深色的是 6.2% 压在 #171717 上——也就是
	 * `--color-color-hover` 那两个值。切到「自定义」的第一下因此没有任何变化，改的人是从现状开始
	 * 改，而不是先被扔到一套陌生的颜色上再往回找。
	 */
	inlineCodeLightBg: "#F4F4F5",
	inlineCodeLightFg: "#1C1C21",
	inlineCodeDarkBg: "#242424",
	inlineCodeDarkFg: "#EDEDED",
	inlineCodeBorder: false,
	contrast: 60,
	pointerCursor: false,
	reduceMotion: "system",
	diffMarkers: "color",
	// Compact by default: the common failure is transient, and its wording is JSON.
	errorDetail: "compact",
	callChain: "collapsed",
	panelLayout: "tabs",
	// 不设 `-webkit-font-smoothing`，字按系统默认的粗细画。
	fontSmoothing: false,
	vibrancy: true,
};

/** A prompt the app sends on its own schedule, in a fresh session each time. */
export interface ScheduledTask {
	id: string;
	name: string;
	/** Workspace the task runs in. */
	cwd: string;
	prompt: string;
	schedule: { kind: "interval"; minutes: number } | { kind: "daily"; time: string };
	enabled: boolean;
	lastRunAt?: number;
	lastSessionId?: string;
	lastError?: string;
}

export interface ScreenshotSettings {
	/** Disabling capture also releases its global shortcut. */
	enabled?: boolean;
	/** Global shortcut to trigger screen capture. e.g. "CommandOrControl+Shift+S" or "Alt+A". */
	shortcut?: string;
	/** Directory where screenshots are saved. If empty, saves to ~/Desktop or scratch directory. */
	saveLocation?: string;
	/**
	 * Where the capture toolbar's download button writes to.
	 *
	 * Separate from `saveLocation`, which is the automatic copy every finished capture leaves behind
	 * — most people want that off. This is the deliberate one: the button says 下载 and the file has
	 * to appear somewhere the user can find without being told, so an empty value means the desktop
	 * rather than nothing at all.
	 */
	downloadLocation?: string;
	/** Whether to show the screenshot button in the composer input area (default false). */
	showInComposer?: boolean;
	/** Whether to automatically copy the screenshot image to clipboard after capture. */
	copyToClipboard?: boolean;
	/** Whether to automatically insert the captured screenshot into the active composer. */
	insertIntoComposer?: boolean;
	/** Action after capture: open the annotator/editor, or just save/copy quietly. */
	openEditor?: boolean;
}

export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
	enabled: true,
	shortcut: "Alt+A",
	saveLocation: "",
	downloadLocation: "",
	showInComposer: false,
	copyToClipboard: true,
	insertIntoComposer: false,
	openEditor: true,
};

export interface Settings {
	/**
	 * Keys for the search services that want one.
	 *
	 * Optional throughout: search works without any of them through the keyless provider, and a key
	 * is an upgrade rather than a prerequisite. Read at call time so pasting one in takes effect
	 * without a restart.
	 */
	searchApiKeys?: { tavily?: string; exa?: string; brave?: string };
	/** Which search provider to use when more than one is usable. */
	searchProvider?: string | null;
	/**
	 * Internal hosts the agent may reach, named one at a time.
	 *
	 * Private addresses are refused rather than asked about, because a prompt showing
	 * `169.254.169.254` is a question almost nobody can answer. Somebody who genuinely runs a
	 * service on their own network needs a way to say so — and this is it: a decision made once,
	 * while thinking about it, rather than mid-turn.
	 *
	 * Matched by hostname. It cannot open a private address reached through a public name, which
	 * is the shape of an attack rather than a configuration anybody intends.
	 */
	allowedHosts?: string[];
	/**
	 * Plume 开着的时候，别让这台电脑睡。
	 *
	 * 开着的时候主进程持有一个系统级的「别休眠」声明（`electron/keep-awake.ts`），保证不息屏、
	 * 不因为闲置而休眠——长任务跑一夜、离开工位回来它还在那儿。
	 *
	 * **不含合盖。** 两个平台的合盖动作都不归应用管（macOS 要 `pmset disablesleep`，Windows 是
	 * 电源计划里的 LIDACTION，都要特权），设置页把这一句写在开关下面，而不是让人自己发现。
	 */
	keepAwake?: boolean;
	/** Plume's interface language. `system` follows the operating system without storing a guess. */
	uiLocale: UiLocale;
	/**
	 * 写进文件、但**没有任何代码读它**。
	 *
	 * 说清楚是因为它看起来像一个版本化迁移的入口，而这里没有版本化迁移：升级靠的是
	 * `migrateAppearance`、`migrateSecrets` 这几张「认得旧值就换成新值」的
	 * 表，各自独立、幂等，和这个数字无关。照着它写一个 `if (parsed.version < 2) …` 的人会得到
	 * 一段永远不跑的代码——因为没有任何地方会把它写成 2，也没有任何地方比较过它。
	 *
	 * 留着而不是删掉：它已经在每个用户的 `settings.json` 里了，`Settings` 的每个构造点都填了它，
	 * 而多一个没人读的字段是无害的。真要上按版本迁移的那一天，第一步是让某处开始写它——在那之前
	 * 这个 `1` 只是一个字面量。
	 */
	version: 1;
	providers: ProviderConfig[];
	/**
	 * 每个见过的供应商最后一次叫什么名字——**包括已经删掉的那些**。
	 *
	 * 用量是按 `providerId` 记的账，名字却只活在 `providers` 里。删掉一个供应商，它花过的钱一分
	 * 不少地留在日志里，用量页上却只剩 `provider-mttnetnn` 这么一串——账还在，是谁花的没了。而那
	 * 恰恰是看这一页时唯一想知道的事。
	 *
	 * 所以每次保存设置都把当前这批 id→名字合并进来（`rememberProviderNames`），**只增不删**：一个
	 * 供应商从 `providers` 里消失，它在这张表里的那一行留着。用量页也写这张表——对早就删掉、名字
	 * 已经丢了的那些，唯一还知道它是谁的人是用户自己。
	 *
	 * 一个 id 一行，几十字节。就算攒上一百个也还是几 KB，不值得为它写清理。
	 */
	providerNames?: Record<string, string>;
	mcpServers: McpServerConfig[];
	projects: ProjectEntry[];
	/** Pinned session IDs across projects and loose chats. */
	pinnedSessionIds?: string[];
	/**
	 * 手动标成未读的会话。和置顶一样存在这里，重启后还在；选中这条会话就清掉。
	 *
	 * 和窗口里 `activity` 的 `done`/`failed` 不是一回事：那两个是「跑完了你还没看」，由事件推出来、
	 * 只在内存里；这个是人自己说「回头再看」，只有人的动作能立起来和放下去。
	 */
	unreadSessionIds?: string[];
	/**
	 * Fold a project away once every one of its conversations is archived.
	 *
	 * Off by default. Archiving the last conversation is a reasonable way to say a project is done
	 * with, and for some people the row left behind is clutter — it looks like a project with work
	 * in it and opens onto nothing. But a project vanishing from the sidebar is also how someone
	 * loses track of where their work went, and that is the worse surprise to hand a person who
	 * did not ask for it. So it is offered rather than assumed.
	 *
	 * Only affects projects that *had* conversations. One that never had any is a project just
	 * added to the list, and it keeps its row either way — otherwise there is nowhere to click to
	 * start the first one.
	 */
	hideEmptiedProjects?: boolean;
	/** Custom session ordering per project: maps project path to ordered session IDs. */
	sessionOrder?: Record<string, string[]>;
	/** Worktrees configuration and auto-cleanup preferences. */
	worktrees?: {
		/** Managed worktrees root directory. Defaults to ~/.plume/worktrees or sibling directory if empty. */
		rootDir?: string;
		/** Automatically create a dedicated worktree when starting a new session. */
		autoCreateOnNewSession?: boolean;
		/** Automatically fetch upstream remotes before creating a worktree. */
		fetchUpstreamBeforeCreate?: boolean;
		/** Auto clean unlinked or old worktrees exceeding limit or session deletion. */
		autoCleanOld?: boolean;
		/** Number of managed worktrees to retain before oldest are pruned. */
		keepLimit?: number;
	};
	/** `${providerId}/${modelId}` of the model used for new sessions. */
	defaultModelId: string | null;
	/** Default for new side chats; null follows the main conversation. */
	sideChatModelId?: string | null;
	/**
	 * Models pinned to the top of the picker, in the order they were starred.
	 *
	 * A relay can serve thirty models and most people use three. Ordering the list by anything
	 * automatic — recency, frequency — makes the position of a row depend on what you did last,
	 * which is the one thing a list you aim at by muscle memory must not do. So it is stated
	 * rather than inferred, and it is stated once.
	 *
	 * Ids that no longer resolve are ignored rather than pruned: a provider switched off for the
	 * afternoon should not silently empty the shortlist.
	 */
	favoriteModelIds?: string[];
	permissionMode: PermissionMode;
	/**
	 * Whether shell commands may reach the network.
	 *
	 * A second axis rather than a fourth permission mode, because it does not sit anywhere on the
	 * existing scale: `auto` is chosen by people who want the agent to edit the project without
	 * being asked, and that is orthogonal to whether it may also `curl` something. Folding the two
	 * together would have meant the only way to take the network away was also to take away the
	 * file access that makes the mode useful.
	 *
	 * Off by default. The command classifier is a blacklist and will keep missing spellings, so
	 * this is the structural answer for anyone who wants one — but turning it on stops
	 * `pnpm install` and `git push`, which is a decision the user has to make rather than inherit.
	 */
	denyCommandNetwork?: boolean;
	thinking: ThinkingLevel;
	/** Legacy total attempts, retained when reading older settings. Prefer retryPolicy. */
	retryAttempts: number;
	retryPolicy?: RetryPolicy;
	/** Last level chosen above "off", restored when fast mode is switched back off. */
	lastThinking?: ThinkingLevel;
	/**
	 * Language the Git panel's AI commit message is written in.
	 *
	 * Global, not per-repository: switching projects must not forget that you asked for English.
	 * A BCP-47-ish id (`zh`, `en`, `ja`, …); unknown values fall back to Chinese.
	 */
	commitLanguage?: string;
	appearance: AppearanceSettings;
	/** 用户级钩子。项目级的在 `.plume/config.json`，不走设置合并，见 `hooks/config.ts`。 */
	hooks: HooksConfig;
	scheduledTasks: ScheduledTask[];
	/**
	 * Plugin ids that are switched off; everything found on disk is on by default.
	 *
	 * `*` is a sentinel meaning "none of them", for a session that has to be reproducible and
	 * therefore cannot inherit whatever happens to be installed. It is not an id, and the settings
	 * page clears it when a plugin is switched back on.
	 */
	disabledPlugins: string[];
	/**
	 * 关掉的技能，按 SKILL.md 的绝对路径记；没列出的都开着，只记关掉的。
	 *
	 * 关掉就是完全不可用：不进提示词，`skill` 工具和 `/` 菜单里都没有。设置页照样列出它们，
	 * 好让人再打开。插件带的技能不在这里单独开关，跟着 `disabledPlugins`。
	 */
	disabledSkills: string[];
	/**
	 * Which file wins a same-name conflict, as `kind:name` → path — 「改用那个」 on the settings page.
	 *
	 * Here rather than in `.plume/config.json` because the value is a path on this machine, and
	 * that file is the one checked into the repository.
	 */
	capabilityPreferences: Record<string, string>;
	/**
	 * 裸的 `cat` / `grep` / `find` / `ls` 改道到专用工具。默认开。
	 *
	 * 关掉的理由只有一个：有人就是想用 shell。而开着的理由是，提示词里那句「用 read 别用
	 * cat」模型看了照样 cat——一个错误结果比一句劝告有效得多。管道和重定向永远放行。
	 */
	rerouteShellCommands?: boolean;
	/**
	 * 是否在会话开始时长文本输入时自动精炼生成会话标题。默认开。
	 *
	 * 开启时，若首条消息有效长度超过 12 个字符，后台自动使用 fast 模型（或当前会话模型）总结标题；
	 * 关闭时，仅截取用户首条消息作为标题。
	 */
	autoSummarizeTitle?: boolean;
	/**
	 * How many sub-agents may run at once. Beyond this they queue.
	 *
	 * A limit rather than a refusal, because wanting to look at eight things is a reasonable thought
	 * and running eight at once is what is not — each carries its own context and its own model
	 * calls. The number reaches the prompt too: a queue is invisible from the inside, and a model
	 * that reads the wait as slowness responds by dispatching more.
	 *
	 * 设置页不再展示它，只在配置文件里可调。见 `runtime/dispatch-guard.ts`。
	 */
	maxConcurrentSubAgents: number;
	/**
	 * Which model answers to `@compact`, `@fast`, `@deep` and `@review`.
	 *
	 * Lets a sub-agent definition name what it needs rather than a specific model — the definition
	 * then works on a machine with a different set of providers, which is what makes one shareable
	 * at all. Empty entries fall through to the session's own model.
	 */
	modelRoles?: Partial<Record<"default" | "compact" | "fast" | "deep" | "review", string>>;
	subAgentProfiles?: Record<string, SubAgentProfile>;
	/**
	 * Whether finished sessions may be read by a model to build project memory.
	 *
	 * Off until somebody says yes. Extraction sends conversation content to a provider, and an app
	 * that otherwise only talks to one when asked must not quietly start doing it on a timer — a
	 * tool people run locally has to be conservative about exactly this.
	 *
	 * `undefined` is "never asked", which the host distinguishes from `false` ("asked, declined")
	 * so it knows whether the prompt is still owed.
	 */
	memoryExtraction?: boolean;
	/**
	 * Plugin registry index URLs the user has added, browsed from the plugins page.
	 *
	 * Ours is preset. The argument against shipping one was that it would point at a collection
	 * whose contents we neither control nor can promise will stay — true of somebody else's list,
	 * and not of the registry maintained alongside this app, whose entries are rebuilt from their
	 * upstreams every day. A fresh install with no sources at all is an empty shop with no way to
	 * know a shop exists.
	 */
	pluginRegistries: string[];
	/**
	 * Where skill collections are listed.
	 *
	 * Separate from `pluginRegistries` because they are separate questions with separate answers: a
	 * plugin index says what to clone and how to run it, a skill index says which folders of
	 * `SKILL.md` a repository holds. Merging them would mean every consumer of either list first
	 * asking which sort of entry it was looking at.
	 */
	skillRegistries: string[];
	/**
	 * 装过的插件、MCP 服务和技能集，市场上一有新版就自己换上。
	 *
	 * 缺省（`undefined`）算开，跟编辑器和启动器的扩展一样：一个装了就不再打开市场的人，不该一直
	 * 用着三个月前的那一版。关掉之后照旧提示「可更新」，只是等人点。
	 */
	autoUpdatePlugins?: boolean;
	/** Rules the user chose to always allow, keyed by tool kind. */
	alwaysAllow: string[];
	/**
	 * Web access: the desktop serving its own interface to browsers on the local network.
	 *
	 * `token` is the secret in the link the settings page hands out; it is kept here so the link
	 * survives a restart, and never leaves this machine except inside that link.
	 */
	webAccess: {
		enabled: boolean;
		port: number;
		token: string | null;
	};
	editor: {
		defaultOpenTarget: string;
		showBottomPanel: boolean;
	};
	screenshot?: ScreenshotSettings;
	browser?: {
		defaultZoom?: number;
		openLinks?: "system" | "builtin";
		/**
		 * Which engine the address bar hands words to, when what was typed is not an address.
		 *
		 * Absent means Bing, which is the one that answers from everywhere this app runs without
		 * asking the user to reach a network they may not have.
		 */
		searchEngine?: "bing" | "google" | "baidu" | "duckduckgo" | "custom";
		/** The template behind `searchEngine: "custom"`, with `%s` where the query goes. */
		searchUrl?: string;
		bookmarks?: { url: string; title: string }[];
	};
	/**
	 * Personalization & custom instructions settings across all sessions.
	 */
	personalization?: {
		/** Empty uses the active provider label in the sidebar footer. */
		sidebarMotto?: string;
		/** Custom instructions injected into system prompt for all sessions. */
		customInstructions?: string;
		/** Whether to enable persistent local memory extraction. */
		enableMemory?: boolean;
		/** Read and record this repository's lessons independently of personal preferences. */
		enableProjectMemory?: boolean;
		/** Whether memory extraction considers MCP tools and search conversations. */
		enableToolAssistedMemory?: boolean;
		/** Tone/personality preference for agent replies. */
		tone?: "friendly" | "professional" | "concise" | "candid" | "humorous";
	};
}

/**
 * 预置的市场源。
 *
 * 平台的条目带构建好的包和 SHA-256，安装是一次校验过的下载，不依赖上游仓库可达；每个包里有几个
 * 技能也事先数好，市场页装之前就能显示。`/v1/index` 一次返回完整清单，形状是 `readIndex` 读的
 * 那种；`?kind=skill` 取技能集合。
 */
const REGISTRY_ORIGIN = "https://market.07230805.xyz";

/** Plugins and MCP servers. */
const DEFAULT_PLUGIN_REGISTRY = `${REGISTRY_ORIGIN}/v1/index`;

/** The same catalogue's skill collections, which the app configures as a separate source. */
const DEFAULT_SKILL_REGISTRY = `${REGISTRY_ORIGIN}/v1/index?kind=skill`;

export const DEFAULT_SETTINGS: Settings = {
	version: 1,
	uiLocale: "system",
	providers: [],
	mcpServers: [],
	projects: [],
	defaultModelId: null,
	permissionMode: "auto",
	thinking: "medium",
	commitLanguage: "zh",
	retryAttempts: 11,
	retryPolicy: DEFAULT_RETRY_POLICY,
	appearance: DEFAULT_APPEARANCE,
	hooks: EMPTY_HOOKS_CONFIG,
	scheduledTasks: [],
	disabledPlugins: [],
	disabledSkills: [],
	capabilityPreferences: {},
	rerouteShellCommands: true,
	autoSummarizeTitle: true,
	hideEmptiedProjects: false,
	maxConcurrentSubAgents: 4,
	modelRoles: {},
	/*
	 * `memoryExtraction` is deliberately absent rather than `undefined`.
	 *
	 * Its whole point is that "never asked" is a third state, and an absent key is how that is
	 * spelled. Written out as `undefined` it becomes a key that exists and holds nothing, which
	 * reads to `Object.keys` as a field somebody deleted.
	 */
	pluginRegistries: [DEFAULT_PLUGIN_REGISTRY],
	skillRegistries: [DEFAULT_SKILL_REGISTRY],
	alwaysAllow: [],
	webAccess: { enabled: false, port: 4517, token: null },
	editor: { defaultOpenTarget: "Zed", showBottomPanel: true },
	screenshot: DEFAULT_SCREENSHOT_SETTINGS,
	searchApiKeys: {},
	allowedHosts: [],
	personalization: {
		customInstructions: "",
		enableMemory: true,
		enableToolAssistedMemory: true,
		tone: "friendly",
	},
};

export function settingsPath(): string {
	return join(plumeHome(), "settings.json");
}

/** Where a provider's key is filed in the vault. */
const providerSecretId = (providerId: string): string => `provider:${providerId}`;

/** Where one value an MCP server needs — a key, a token, a connection string — is filed. */
const mcpSecretId = (serverId: string, name: string): string => `mcp:${serverId}:${name}`;

/** What stands in the file where a vaulted MCP value was: the placeholder that names it. */
const holeFor = (name: string): string => `\${${name}}`;

/**
 * Whether one of a server's `env` values belongs in the vault: what its bundle said about it, and
 * otherwise what the name suggests (`mcp/placeholders.ts`).
 */
function isSecretEnv(server: McpServerConfig, name: string): boolean {
	return server.needs?.find((need) => need.name === name)?.secret ?? looksSecret(name);
}

/**
 * Put the API keys back on the providers, from the vault.
 *
 * The rest of the app reads `provider.apiKey` and always has; keeping that true means the change
 * of where the key is *stored* stops at this file rather than reaching every request builder and
 * settings pane. What comes off disk has an empty `apiKey`, and this fills it in.
 *
 * A key still sitting in `settings.json` is honoured rather than ignored — that is what every
 * install written by an earlier build looks like, and refusing it would log everyone out of their
 * model providers to fix a problem about writing them down. `saveSettings` moves it on the next
 * write; `migrateSecrets` moves it without waiting for one.
 */
async function withKeys(settings: Settings): Promise<Settings> {
	if (settings.providers.length === 0 && settings.mcpServers.length === 0) return settings;
	const providers = await Promise.all(
		settings.providers.map(async (provider) => {
			const stored = await secret(providerSecretId(provider.id));
			// `stored` wins: it is the newer of the two whenever both exist.
			return stored === null ? provider : { ...provider, apiKey: stored };
		}),
	);
	/*
	 * An MCP server's keys come back the same way, into the `env` they were taken out of. Only where
	 * the file holds the placeholder naming itself — which is what `writeSettings` leaves behind. A
	 * value typed into the file by hand is newer than anything in the vault, and is kept.
	 */
	const mcpServers = await Promise.all(
		settings.mcpServers.map(async (server) => {
			if (!server.env) return server;
			let env: Record<string, string> | null = null;
			for (const [name, value] of Object.entries(server.env)) {
				if (value !== holeFor(name)) continue;
				const stored = await secret(mcpSecretId(server.id, name));
				if (stored === null) continue;
				env ??= { ...server.env };
				env[name] = stored;
			}
			return env ? { ...server, env } : server;
		}),
	);
	return { ...settings, providers, mcpServers };
}

export async function loadSettings(): Promise<Settings> {
	return withKeys(await readSettingsFile());
}

/**
 * The settings a particular project sees: the global settings with `<cwd>/.plume/config.json` over it.
 *
 * Takes settings already in hand rather than reading the file, because a running session gets its
 * global settings handed to it — the desktop keeps one copy and pushes changes down — and
 * re-reading the file to apply the project layer would race with whatever change was being pushed.
 *
 * The project layer cannot carry credentials or providers (`sanitizeProjectConfig`): that file is
 * checked into the repository, so anything in it is shared with everyone who clones it.
 */
export async function layerProjectSettings(
	global: Settings,
	cwd: string | null,
): Promise<{ settings: Settings; refused: string[]; error?: string }> {
	if (!cwd) return { settings: global, refused: [] };

	const { loadProjectLayer, mergeLayer } = await import("./layers.ts");
	const project = await loadProjectLayer(cwd);
	if (Object.keys(project.config).length === 0) {
		return { settings: global, refused: project.refused, error: project.error };
	}

	/*
	 * Merged as data and then re-normalised, rather than assigned field by field.
	 *
	 * `normalizeSettings` is where every bound and fallback lives — a project setting
	 * `maxConcurrentSubAgents: 500` has to meet the same ceiling a global one does, and a field-by-
	 * field merge would be a second place those rules have to be kept in step.
	 */
	const merged = mergeLayer(global as unknown as Record<string, unknown>, project.config);
	return { settings: normalizeSettings(merged), refused: project.refused, error: project.error };
}

/**
 * Settings exactly as written, with whatever `apiKey` the file happens to hold.
 *
 * Separate from `loadSettings` because the migration needs to see the plaintext that is still on
 * disk, and because `saveSettings` needs to compare against what was there without the vault's
 * answer masking it.
 */
async function readSettingsFile(): Promise<Settings> {
	const path = settingsPath();
	const raw = await readFile(path, "utf8").catch(() => null);
	// Missing or empty is a fresh install, not damage: there is nothing in it to lose.
	if (!raw?.trim()) return { ...DEFAULT_SETTINGS };
	try {
		const parsed: unknown = JSON.parse(withoutBom(raw));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the top level is not a JSON object");
		const settings = normalizeSettings(parsed as Partial<Settings>);
		// Mended by hand before anything wrote over it. A copy already kept aside is still worth naming.
		if (problem?.path === path && !problem.keptAt) problem = null;
		return settings;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		problem = { path, reason, keptAt: problem?.path === path ? problem.keptAt : undefined };
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Why `settings.json` could not be used, when it could not.
 *
 * It used to be a `catch` that returned the defaults and said nothing. The app then ran as a fresh
 * install — no providers, no MCP servers, no hooks, no always-allow list — and the first save, which
 * the desktop makes on any change at all, wrote those defaults over the file: the one copy of what
 * had been configured, gone because it could not be parsed. The commonest cause was not damage but
 * a byte-order mark (see `withoutBom`), which is now simply read; this is for a file that cannot be.
 */
export interface SettingsProblem {
	/** The file it is about. A test, or a host that moved `PLUME_HOME`, reads another file entirely. */
	path: string;
	/** What the parser said. */
	reason: string;
	/** Where the unreadable file was copied before the first save replaced it; absent until then. */
	keptAt?: string;
}

let problem: SettingsProblem | null = null;

/** The trouble with the settings file in use, for a host to put in front of the user; null when none. */
export function settingsProblem(): SettingsProblem | null {
	return problem?.path === settingsPath() ? problem : null;
}

/** The same, as a sentence to show — see `AgentSession.initialize`. */
export function describeSettingsProblem(found: SettingsProblem): string {
	return found.keptAt
		? `${found.path} 读不出来（${found.reason}），原文件已另存为 ${found.keptAt}。现在用的是默认设置：模型供应商、MCP 服务器、hooks 要从那份文件里找回来。`
		: `${found.path} 读不出来（${found.reason}），这次按默认设置运行，模型供应商、MCP 服务器、hooks 都没有加载。文件本身没有动过：修好之后重启 Plume；在那之前保存设置，会先把它另存一份再写入。`;
}

/**
 * Copy an unreadable settings file aside, once, before the first write replaces it.
 *
 * Copied rather than moved, so that a crash between this and the write leaves the original where it
 * was instead of no file at all — which would read as a fresh install, with nothing saying where the
 * old one went.
 */
async function keepUnreadable(path: string): Promise<void> {
	if (problem?.path !== path || problem.keptAt) return;
	const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	try {
		await copyFile(path, aside, constants.COPYFILE_EXCL);
	} catch (error) {
		// Deleted by hand since it was read: nothing left to protect. Anything else stops the save.
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	}
	problem = { ...problem, keptAt: aside };
}

/**
 * 去掉旧版本让模型跟随目录的标记。现在目录只在导入和选中时填一次值，之后配置归用户；这些键留着
 * 只会让人以为它们还起作用。
 */
function withoutCatalogLinks(model: ModelConfig): ModelConfig {
	const { metadataSource: _source, overrides: _overrides, catalogRef: _ref, ...rest } = model as ModelConfig & Record<"metadataSource" | "overrides" | "catalogRef", unknown>;
	return rest;
}

/**
 * A settings object as written, brought up to the shape the app expects.
 *
 * Split out of `readSettingsFile` so that every layer goes through it. A project's
 * `.plume/config.json` setting `maxConcurrentSubAgents: 500` has to meet the same ceiling a global
 * one does, and merging layers field by field would put those bounds in a second place that has to
 * be kept in step with this one.
 */
export function normalizeSettings(parsed: Partial<Settings>): Settings {
		// Merge against defaults so a settings file written by an older build keeps working.
		return {
			...DEFAULT_SETTINGS,
			...parsed,
			uiLocale: normalizeUiLocale(parsed.uiLocale),
			retryPolicy: normalizeRetryPolicy(parsed.retryPolicy, parsed.retryAttempts),
			webAccess: { ...DEFAULT_SETTINGS.webAccess, ...parsed.webAccess },
			editor: { ...DEFAULT_SETTINGS.editor, ...parsed.editor },
			screenshot: { ...DEFAULT_SCREENSHOT_SETTINGS, ...parsed.screenshot },
			personalization: { ...DEFAULT_SETTINGS.personalization, ...parsed.personalization },
			appearance: migrateAppearance({ ...DEFAULT_APPEARANCE, ...parsed.appearance }),
			hooks: normalizeHooksConfig(parsed.hooks),
			scheduledTasks: parsed.scheduledTasks ?? [],
			disabledPlugins: parsed.disabledPlugins ?? [],
			disabledSkills: parsed.disabledSkills ?? [],
			capabilityPreferences: parsed.capabilityPreferences ?? {},
			rerouteShellCommands: parsed.rerouteShellCommands !== false,
			autoSummarizeTitle: parsed.autoSummarizeTitle !== false,
			// Off unless asked for: a project disappearing from the sidebar is the worse surprise.
			hideEmptiedProjects: parsed.hideEmptiedProjects === true,
			maxConcurrentSubAgents: normalizeMaxConcurrentSubAgents(parsed.maxConcurrentSubAgents),
			/*
			 * Spread rather than assigned, so "never asked" is an absent key rather than a present
			 * one holding `undefined`.
			 *
			 * The two are the same to every reader — `settings.memoryExtraction` is undefined either
			 * way — and different to `Object.keys`, to which a key that is always there and always
			 * undefined reads as a field somebody deleted.
			 */
			...(typeof parsed.memoryExtraction === "boolean" ? { memoryExtraction: parsed.memoryExtraction } : {}),
			subAgentProfiles: normalizeSubAgentProfiles(parsed.subAgentProfiles),
			modelRoles:
				parsed.modelRoles && typeof parsed.modelRoles === "object"
					? Object.fromEntries(
							Object.entries(parsed.modelRoles as Record<string, unknown>).filter(
								([key, value]) => ["default", "compact", "fast", "deep", "review"].includes(key) && typeof value === "string" && value,
							),
						)
					: {},
			/*
			 * A missing list gets the default; an empty one is left empty.
			 *
			 * The two are different intentions written the same way in JSON, and only one of them is
			 * the user's: never having been asked, versus having removed every source deliberately.
			 * `??` distinguishes them exactly.
			 */
			pluginRegistries: parsed.pluginRegistries ?? [DEFAULT_PLUGIN_REGISTRY],
			skillRegistries: parsed.skillRegistries ?? [DEFAULT_SKILL_REGISTRY],
			providers: (parsed.providers ?? []).map((provider) => ({ ...provider, models: provider.models.map(withoutCatalogLinks) })),
			// 只留 id→非空字符串那些行：这张表会被直接印到用量页上，一行 `undefined` 比没有那一行更糟。
			providerNames: Object.fromEntries(
				Object.entries(parsed.providerNames ?? {}).filter(([id, name]) => id && typeof name === "string" && name.trim()),
			),
			mcpServers: parsed.mcpServers ?? [],
			projects: parsed.projects ?? [],
			/*
			 * Without the escalations an earlier version remembered.
			 *
			 * Its escalation card offered "stop asking" and wrote the answer here. An escalation is
			 * granted for one call, and the gate consults nothing remembered for one, so such a line
			 * grants nothing — kept, the settings page would list it as always allowed. The prefix is
			 * the one `bash.ts` gives an escalation's subject.
			 */
			alwaysAllow: (Array.isArray(parsed.alwaysAllow) ? parsed.alwaysAllow : []).filter(
				(subject) => typeof subject === "string" && !subject.startsWith("escalate:"),
			),
		};
}

/**
 * Font stacks that were once the default, and are no longer.
 *
 * Settings are written out in full, so every existing install has the old system stack recorded
 * as if it had been chosen deliberately — a new default would never reach anyone. Anything still
 * holding a value this list knows about is taken to have never made a choice, and moves on.
 * A stack the user actually typed is not in the list, and stays.
 */
const SUPERSEDED_FONTS: Record<"uiFont" | "codeFont", string[]> = {
	uiFont: [
		'-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
		'"Inter Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
		'"IBM Plex Sans Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
		'"PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
	],
	codeFont: [
		'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
		'"JetBrains Mono Variable", ui-monospace, "SF Mono", SFMono-Regular, Menlo, "PingFang SC", monospace',
	],
};

/** Foreground colours that were once the default; same reasoning as `SUPERSEDED_FONTS`. */
const SUPERSEDED_FOREGROUNDS: Record<"lightForeground" | "darkForeground", string[]> = {
	lightForeground: ["#1A1C1F", "#404040"],
	darkForeground: ["#EDEDED", "#E5E5E5"],
};

/**
 * Settings that no longer exist, dropped rather than carried forever.
 *
 * The file is merged over the defaults and written back out in full, so a key nothing reads any
 * more still survives every save — and the next person to grep for it finds it live in real
 * settings files and has to work out whether it means anything. It does not.
 *
 * `translucentSidebar` turned the sidebar into macOS vibrancy. It was removed because a translucent
 * pane cannot be matched by anything opaque drawn on top of it: a pinned row has to hide the list
 * going under it, and no colour CSS can name is the colour of a pane showing the desktop through.
 * Every held row was a visible slab, and which shade of wrong depended on the wallpaper.
 *
 * `uiFontWeight` was a base weight the whole UI hierarchy was derived from. Weights are now fixed
 * at Tailwind's 400 / 500 / 600 / 700, so a stored value would mean nothing.
 *
 * `codeFontWeight` did the same for code. Code is now set at the body's 400.
 */
const REMOVED_APPEARANCE = ["translucentSidebar", "uiFontWeight", "codeFontWeight"] as const;

export function migrateAppearance(appearance: AppearanceSettings): AppearanceSettings {
	const next = { ...appearance };
	for (const key of ["uiFont", "codeFont"] as const) {
		if (SUPERSEDED_FONTS[key].includes(next[key])) next[key] = DEFAULT_APPEARANCE[key];
	}
	for (const key of ["lightForeground", "darkForeground"] as const) {
		if (SUPERSEDED_FOREGROUNDS[key].includes(next[key].toUpperCase())) next[key] = DEFAULT_APPEARANCE[key];
	}
	for (const key of REMOVED_APPEARANCE) delete (next as Record<string, unknown>)[key];
	return next;
}

/**
 * Write the settings, with the API keys taken out of them.
 *
 * The keys go to the vault and the file gets an empty string in their place. `settings.json` is
 * the most-travelled file this app owns — it is copied between machines and pasted into bug
 * reports — and it was written world-readable with every provider key in it.
 *
 * Removed providers are forgotten in the same pass. A key whose provider is gone is a secret with
 * nothing to spend it on, and leaving it behind would mean deleting a provider does not delete its
 * credential.
 */
/**
 * 把这批供应商的名字记进档案，一行都不删。
 *
 * 只增不删就是全部的意思：这张表存在的理由，就是活过 `providers` 里的那个删除动作。改名照样覆盖
 * ——改完之后用量页该显示新名字——但 id 一旦进来就不再出去。
 *
 * 纯函数，幂等，所以落盘（`saveSettings`）和内存（desktop 的 `applySettings`）两头都调它：只写
 * 一头的话，删掉一个供应商之后用量页要等到下次启动才认得出它是谁。
 *
 * 没名字的不记。一个刚点「添加」、名字还没填的供应商不该在档案里占一行叫「」。
 */
export function rememberProviderNames(settings: Pick<Settings, "providers" | "providerNames">): Record<string, string> {
	const known = { ...settings.providerNames };
	for (const provider of settings.providers) {
		if (provider.name?.trim()) known[provider.id] = provider.name;
	}
	return known;
}

/** The save in progress; the next one starts after it. See `saveSettings`. */
let saving: Promise<unknown> = Promise.resolve();

/**
 * One save at a time, in the order they were asked for.
 *
 * The desktop app saves on every change without waiting for the previous save, so flipping two
 * switches quickly puts two in flight. Run side by side they wrote the vault and this file through
 * one shared temporary name and failed with ENOENT; and even with names of their own, whichever
 * finished last would win — not necessarily the one made last.
 */
export function saveSettings(settings: Settings): Promise<void> {
	const run = saving.then(() => writeSettings(settings));
	saving = run.catch(() => {});
	return run;
}

async function writeSettings(settings: Settings): Promise<void> {
	const keys: Record<string, string> = {};
	for (const provider of settings.providers) keys[providerSecretId(provider.id)] = provider.apiKey ?? "";
	/*
	 * An MCP server's secrets leave the file the same way: into the vault, with the placeholder that
	 * names them left in their place — so the file still says where the value goes, and a copy of it
	 * on another machine asks for the key instead of starting without one.
	 */
	const mcpServers = settings.mcpServers.map((server) => {
		if (!server.env) return server;
		const env = { ...server.env };
		for (const [name, value] of Object.entries(env)) {
			if (!value || isPlaceholder(value) || !isSecretEnv(server, name)) continue;
			keys[mcpSecretId(server.id, name)] = value;
			env[name] = holeFor(name);
		}
		return { ...server, env };
	});
	await putSecrets(keys);
	// Removed providers and servers — and a key somebody cleared — are forgotten in the same pass.
	await keepSecrets((id) => (!id.startsWith("provider:") && !id.startsWith("mcp:")) || id in keys);

	await mkdir(plumeHome(), { recursive: true });
	const scrubbed: Settings = {
		...settings,
		// 密钥跟着供应商一起走，名字不跟着走——见 `providerNames`。
		providerNames: rememberProviderNames(settings),
		providers: settings.providers.map((provider) => ({ ...provider, apiKey: "" })),
		mcpServers,
	};
	// Never over a file that could not be read without keeping a copy first; see `SettingsProblem`.
	await keepUnreadable(settingsPath());
	/*
	 * 0600, which it never was.
	 *
	 * The keys are out of it now, but what is left still describes every project on this machine
	 * and every endpoint it talks to. It was 0644 — readable by every other account on the box —
	 * for no reason other than that nothing ever set it.
	 */
	await writeFileAtomic(settingsPath(), JSON.stringify(scrubbed, null, 2), { mode: 0o600 });
}

/**
 * Move any key still written in `settings.json` into the vault, once.
 *
 * `saveSettings` does this too, but only when something is saved — and somebody who never opens
 * the settings page would keep their keys in a world-readable file indefinitely. Called at
 * startup, where it is a no-op on every launch after the first.
 *
 * Returns how many were moved, which the caller logs and the tests assert on.
 */
export async function migrateSecrets(): Promise<number> {
	const onDisk = await readSettingsFile();
	const plaintext =
		onDisk.providers.filter((provider) => provider.apiKey).length +
		onDisk.mcpServers
			.flatMap((server) => Object.entries(server.env ?? {}).map(([name, value]) => ({ server, name, value })))
			.filter(({ server, name, value }) => value && !isPlaceholder(value) && isSecretEnv(server, name)).length;
	if (plaintext === 0) return 0;
	// Through `withKeys` so a provider already in the vault is not overwritten by the stale copy
	// the file still carries.
	await saveSettings(await withKeys(onDisk));
	return plaintext;
}

/*
 * 找模型的那两个函数住在 `models.ts`，从这里再导出。
 *
 * 它们是纯的，而这个文件顶上就是 `node:fs` 和 `node:os`。渲染器要用它们，从这里导入会把整条
 * 依赖链拉进浏览器包——窗口一片空白，报的是 `node:os.homedir` 不能在客户端访问。搬过去之后
 * 这里仍然导出同一个名字，所以原来的调用点一个字都不用改。
 */
export { availableModels, resolveModel } from "./models.ts";
