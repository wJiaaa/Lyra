/**
 * What a tool is, what it is given, and what it may have to ask first.
 *
 * A tool is a spec the model sees plus a function the runtime calls. Everything it needs to do its
 * job — where it runs, how to say something, how to ask permission, how to delegate — arrives in
 * one context object rather than through imports, which is what lets a host substitute any of it.
 */

import type { FormField, FormValues } from "../mcp/form.ts";
import type { SandboxMode } from "../sandbox/policy.ts";
import type { ResourceRouter } from "../resources/router.ts";
import type { RiskCode, RiskParams } from "../tools/risk-reasons.ts";
import type { Message, UserContent } from "./message.ts";
import type { ProviderConfig } from "./provider.ts";

export type { RiskCode, RiskParams };

export interface SubAgentAnswer {
	text: string;
	output?: Record<string, unknown>;
	warnings?: string[];
	/** 登记簿里的 id——续跑它要用的就是这个。没有登记簿的宿主（CLI、测试）没有。 */
	id?: string;
	/** 没做完就停下了：到了检查点、原地打转、或者上游出错。它的上下文还在，可以续跑。 */
	incomplete?: boolean;
	/** 人在面板上把它按停的。派它来的那一方不该自作主张地让它接着跑。 */
	stoppedByUser?: boolean;
	/**
	 * 父会话没等它跑完就放手了：人插了话，父会话先去回应。它在后台接着跑，跑完后结果由运行时
	 * 作为一条消息送回——见 `runtime/sub-agent/delegation-waits.ts`。这时 `text` 说的是「它还在跑」，不是结论。
	 */
	detached?: boolean;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema subset accepted by every provider we target. */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	required?: string[];
	enum?: unknown[];
	description?: string;
	default?: unknown;
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface ToolResult {
	/** What the model sees. */
	content: UserContent[];
	/** What the UI renders. Never serialized into the provider payload. */
	details?: unknown;
	isError?: boolean;
	/**
	 * This result carries no information for later reasoning.
	 *
	 * A search with no matches, an empty directory, a command that exited 0 and said nothing. They
	 * take up room in the window and answer nothing that will be asked again, so compaction drops
	 * them first — the pair is emptied in place rather than removed, because a `tool_use` without
	 * its `tool_result` makes the provider reject every later request in the conversation.
	 *
	 * Mutually exclusive with `isError` in practice: an error is always worth keeping, and a tool
	 * that sets both should be read as an error.
	 */
	uneventful?: boolean;
	/**
	 * End the agent turn after this tool, even if the model wanted to keep going.
	 *
	 * 给「做完这件事本身就等于这一轮做完了」的工具用：`yield` 的结果已经交进 `state`，派生的调用方
	 * 读的是那个对象，此后再问模型一句话，没有任何人会读到答案；桌面端的 `archive_session` 要等这一轮
	 * 结束才归档，之后说的话会跟着对话一起被收起来，没人读。
	 *
	 * 读它的是 `agent/loop.ts`，那里也写着这根线断着的时候会发生什么。出错的结果上写这个不作数，
	 * 见 `agent/tool-run.ts`。
	 */
	terminate?: boolean;
}

export interface ToolContext {
	/**
	 * 这一轮的工具，被延迟的在内。`mcp_search` 在其中被延迟的那些里搜：权限档、子代理定义筛掉的，
	 * 这里本来就没有。
	 */
	tools?: readonly Tool[];
	/** Absolute working directory for this session. */
	cwd: string;
	sessionId: string;
	signal?: AbortSignal;
	/** Push an in-progress result so the UI can stream long-running tools. */
	onProgress?: (partial: ToolResult) => void;
	/**
	 * What this call leaves behind if the turn is stopped before it returns.
	 *
	 * Stop races every call (`agent/tool-run.ts`), so whatever the tool would have returned after
	 * the stop is thrown away and the model reads only "cancelled". A call whose work outlives the
	 * turn — a sub-agent whose context can be resumed — says so here, and the runner appends it to
	 * that "cancelled". The latest call wins.
	 */
	ifStopped?: (left: ToolResult) => void;
	/** Ask the user to approve a side-effecting operation. */
	requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/**
	 * How much of the filesystem this turn's commands may change.
	 *
	 * Set by the host from the permission mode. Absent means the host composed no sandbox, and a
	 * tool that would have been confined runs the way it always did — which is what keeps the CLI
	 * and the tests working without building one.
	 */
	sandboxMode?: SandboxMode;
	/*
	 * The search provider the user picked in settings, carried to `web_search`.
	 *
	 * The tool cannot read settings, and which service to pay for is the user's call rather
	 * than the model's — so it travels with the turn like the other per-session decisions.
	 * Absent or null means none was picked, which is a case `search/index.ts` decides.
	 */
	searchProviderId?: string | null;
	/**
	 * 配好的供应商和设置里的默认生图模型，带给 `image_generate`，由它按 `resolveImageModel` 挑。
	 *
	 * 和搜索服务一样是人的决定：工具读不到设置，模型也不该替人挑花谁的钱——它只在人点了名时
	 * 传 `model`。带的是整张表而不是挑好的那一个，因为点名要在这张表里找。
	 */
	imageModels?: { providers: readonly ProviderConfig[]; preferred: string | null } | null;
	/**
	 * Specific files outside the workspace explicitly granted to this turn
	 * (e.g. user-attached files from messages in this session).
	 */
	allowedPaths?: ReadonlySet<string>;
	/**
	 * The other source folders of the project this session runs in.
	 *
	 * A project may be several directories; `cwd` is only the one the session runs in. Read
	 * judgements ask about the whole set — see `config/project-roots.ts` for how it is derived and
	 * `tools/read-access.ts` for what it changes.
	 */
	projectRoots?: readonly string[];
	/**
	 * Run a nested agent (used by the `task` tool).
	 *
	 * Returns prose plus, when the agent declared an output schema and yielded against it, the same
	 * answer as an object. The parent tool passes the object through in `details` rather than
	 * flattening it, so the renderer and `agent://` can both index into it.
	 */
	spawnSubAgent?: (input: SubAgentInput) => Promise<SubAgentAnswer>;
	/**
	 * 等一件不在这一轮里的事，但人一开口就放手：放手时交回 `null`。
	 *
	 * 插话只在两轮之间才有人取，卡在等待上的工具调用会把人说的话压到它返回为止。只有主会话给
	 * （见 `delegation-waits.ts`）；没有它，工具就一直等到底。
	 */
	untilSpokenTo?: <T>(run: Promise<T>) => Promise<T | null>;
	/** Shared per-session scratch space (todo list, file read cache, ...). */
	state: Map<string, unknown>;
	/**
	 * The session's address space: `skill://`, `scratch://`, `plume://`.
	 *
	 * Per session rather than a module singleton, because a sub-agent has its own skill set and a
	 * shared router would resolve `skill://x` against whichever session touched it last.
	 *
	 * Optional so a bare context — the CLI, a test — still works: with no router, `read` treats
	 * every argument as a file path, which is what it did before addresses existed.
	 */
	resources?: ResourceRouter;
	/** Where `scratch://` writes. Absent in sessions with no scratch space. */
	scratchDir?: string;
	/**
	 * Store a web preview and return where it went.
	 *
	 * Provided by the host, because where these files live is the host's business — they are
	 * conversation artifacts kept under the app's own directory, never in the user's project.
	 */
	writePreview?: (input: {
		id: string;
		title: string;
		files: { path: string; content: string }[];
		entry?: string;
		themed?: boolean;
	}) => Promise<{ id: string; sessionId: string; title: string; entry: string; dir: string; themed?: boolean }>;
	/**
	 * Every message this session ever committed, truncated ones included — what `recall` searches.
	 *
	 * Provided by the host from the session's own store, so a host that keeps sessions somewhere
	 * else (the `storage` seam) is the one read. Absent in a bare context, where `recall` falls back
	 * to the default store on this disk.
	 */
	transcript?: () => Promise<Message[]>;
}

export interface AskUserOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface QuestionFields {
	options?: (string | AskUserOption)[];
	allowCustomInput?: boolean;
	selectionMode?: "single" | "multi";
	allowSkip?: boolean;
	defaultOptionIndex?: number;
}

export interface ApprovalRequest extends QuestionFields {
	/**
	 * `interactive` 是 `ask_user` 的提问；`form` 是 MCP 服务器在工具调用中途要人填的一张表
	 * （`elicitation/create`）。这两种问的是人，不是许可：任何权限模式下都不会被自动回答。
	 */
	kind: "bash" | "write" | "edit" | "read" | "mcp" | "network" | "interactive" | "form";
	title: string;
	/** `form` 的那几格，由 `mcp/form.ts` 从服务器的 schema 读出来。 */
	fields?: FormField[];
	detail: string;
	/**
	 * Why this is being asked, in the asker's own words.
	 *
	 * The difference between a prompt somebody can answer and one they can only guess at. A path
	 * and a mode describe what would happen; this says what it is for — and when the asker is the
	 * model requesting an escalation, it is the model's own sentence, shown verbatim.
	 */
	reason?: string;
	/**
	 * What the approval policy found dangerous, when that is why this is being asked.
	 *
	 * Set by the gate, beside `detail` rather than written into it: written in, it was a sentence
	 * in the language it was composed in, whatever the window was set to.
	 */
	risk?: ApprovalRisk;
	/** Command / path the approval applies to, used for "always allow" rules. */
	subject: string;
	/**
	 * The asker says this action changes nothing — today an MCP tool's `readOnlyHint`. A claim, not
	 * a fact: a policy may let it count only together with `trusted`. See `mcp/tool.ts`.
	 */
	readOnly?: boolean;
	/** The asker says this action deletes or overwrites — an MCP tool's `destructiveHint`. Only ever makes a policy more careful. */
	destructive?: boolean;
	/** The person has said they trust this asker's own claims (`readOnly`): an MCP server switched to 信任只读声明. */
	trusted?: boolean;
	/**
	 * The wider sandbox mode this asks to run under, set only on an escalation.
	 *
	 * A field rather than something read out of `subject`, because the gate has to know it for
	 * certain: neither the approval policy nor an "always" rule answers an escalation
	 * (see `ApprovalGate.request`).
	 */
	escalation?: SandboxMode;
	/**
	 * PreToolUse 钩子要求确认的这一次：钩子明说要问人，`auto` 下的审批策略不能替人答。
	 * 策略拿到的 `subject` 只是工具名，按它判出的「不危险」是在判一个不存在的命令。
	 */
	byHook?: boolean;
	/**
	 * 是哪个子代理在问。主会话自己问的没有这一项。
	 *
	 * 子代理的授权一直送到主窗口的同一张卡片上，只是卡片说不出是谁在要——而后台可能同时有四个
	 * 在跑，人要据以决定的恰恰是「这个活该不该由它来干」。
	 */
	from?: ApprovalOrigin;
}

/**
 * The policy's finding, in two forms.
 *
 * `code` names the built-in rule, for the host to say in the interface's language; `text` is the
 * policy's own sentence — what a plugin's policy has to offer, and what is shown for a code the
 * host has no words for.
 */
export interface ApprovalRisk {
	text: string;
	code?: RiskCode;
	params?: RiskParams;
}

/** 提出授权请求的那个子代理。 */
export interface ApprovalOrigin {
	subAgentId: string;
	agent: string;
	description: string;
}
/**
 * 一张卡片的回答。表单有三种：交了（`values`）、拒绝（`reject`，对应协议的 decline）、
 * 没回答就关掉（`cancel`）——超时、撤回、服务器自己取消了也是 `cancel`。
 */
export type ApprovalDecision = "once" | "always" | "reject" | "skip" | "cancel" | { answer: string | string[]; skipped?: boolean } | { values: FormValues };

export interface SubAgentInput {
	description: string;
	prompt: string;
	agentType?: string;
	model?: string;
	/**
	 * 接着跑哪一个，而不是新派一个。
	 *
	 * 设了它，`prompt` 就是说给那个子代理的下一句话：它带着自己读过、做过的全部上下文从停下的
	 * 地方继续。`agentType` 此时不起作用——它是谁，由它当初被派出去时定下。
	 */
	resume?: string;
	/**
	 * 从这一刻起它停下也能续跑，id 是这个。
	 *
	 * 给 `task` 用：整轮被停时它的返回值会被丢掉（见 `ToolContext.ifStopped`），能续跑的 id 只能
	 * 提前递出来。新派的在拿到名额之后才叫——排着队就被停的那种什么都没留下，续不了。
	 */
	onResumable?: (id: string) => void;
}

export interface Tool<TArgs = Record<string, unknown>> extends ToolSpec {
	/**
	 * Whether a call may overlap its neighbours in the same batch. Absent means "parallel".
	 *
	 * A "sequential" call runs alone, after everything before it and before everything after; the
	 * parallel calls between two of them still run together.
	 */
	executionMode?: "parallel" | "sequential";
	/** The same decision made per call, when the arguments settle it — a read-only `bash` command. */
	executionModeFor?(args: TArgs): "parallel" | "sequential";
	/** Tools that mutate the workspace go through the approval flow. */
	mutating?: boolean;
	/**
	 * PreToolUse 钩子要求确认这次调用时，卡片按哪一类来写。工具自己要授权时各自填 `kind`，用不到这里。
	 * 不写的按 MCP 工具算。
	 */
	approvalKind?: Exclude<ApprovalRequest["kind"], "interactive" | "form">;
	/**
	 * 只给会话本身，派出去的子代理拿不到。
	 *
	 * 定义里 `tools: "*"` 的子代理继承会话的全部工具，宿主注入的也在内。跨会话通信是会话之间的事：
	 * 子代理以会话的名义给别人写信，回信却送回会话，子代理自己永远收不到。
	 */
	sessionOnly?: boolean;
	/** 来自哪台 MCP 服务器、在那台上叫什么。延迟加载按它分组、搜索、写目录（`tools/mcp-search.ts`）。 */
	mcp?: { tool: string; server(): { id: string; name: string; description?: string } };
	/**
	 * 这一轮被留在工具表外：MCP 工具超过阈值时会话做出的副本（`withhold`），定义上不写。内置工具不延迟，
	 * 理由见 `docs/architecture/mcp-search.md`。
	 */
	deferred?: boolean;
	execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
	/** One-line summary shown in the UI while the tool runs. */
	summarize?(args: TArgs): string;
}
