export { DEFAULT_RETRY_POLICY, DEFAULT_RETRY_RULE, normalizeRetryPolicy, policyDelay, type RetryPolicy, type RetryPolicySource, type RetryRule, type RetryFailure } from "./config/retry-policy.ts";
export {
	APPROVAL,
	COMPACTION,
	Context,
	DEFAULT_PLUGINS,
	EVENTS,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	createContext,
	type ApprovalPolicy,
	type ApprovalVerdict,
	type CompactionRequest,
	type CompactionStrategy,
	type LlmRegistry,
	type Plugin as CapabilityPlugin,
	type Sandbox,
	type SandboxProcess,
	type SkillRegistry,
	type TaskScheduler,
	type TurnPipeline,
	type ToolRegistry,
} from "./kernel/index.ts";
export { bootHostKernel, registerDefaultSearchProviders, type HostKernel } from "./kernel/host.ts";
export { getSandbox, useSandbox, LocalSandbox, primeCommandPath } from "./sandbox/index.ts";
/** 登录 shell 的环境——MCP 服务就在这份环境里启动，「这个变量有没有设」也要问它。 */
export { commandEnv } from "./sandbox/login-path.ts";
export { useSandboxRunner, workspaceWriteSid, tempWriteSid } from "./sandbox/index.ts";
export {
	registerSearchProvider,
	resetSearchProviders,
	search,
	searchProviders,
	selectSearchProvider,
	SearchError,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	type SearchSource,
} from "./search/index.ts";
export { duckDuckGoProvider, DUCKDUCKGO_PROVIDER_ID } from "./search/duckduckgo.ts";
export { instantAnswerProvider, INSTANT_PROVIDER_ID } from "./search/instant.ts";
export { keyedSearchProvider, BRAVE_PROVIDER_ID, EXA_PROVIDER_ID, TAVILY_PROVIDER_ID } from "./search/keyed.ts";
export { approvalPolicy, useApprovalPolicy } from "./runtime/approval-policy.ts";
export type { ActiveDay, SessionStorage } from "./session/storage.ts";
export { SessionDbUnavailable } from "./session/db.ts";
export type { SpendCall, SpendRow } from "./session/spend.ts";
export {
	countBySource,
	filterTrajectory,
	forkBeforeMessage,
	forkSession,
	matchRanges,
	messagesUpTo,
	readTrajectory,
	TrajectoryReader,
	replaySession,
	SOURCE_LABEL,
	SOURCE_ORDER,
	type Entry as TrajectoryEntry,
	type ForkResult,
	type Source as TrajectorySourceKind,
	type TrajectoryFilter,
	type TrajectoryChanges,
} from "./trajectory/index.ts";
export { nextTask, useScheduler } from "./runtime/scheduling.ts";
export { isDue, nextRunAt } from "./config/schedule.ts";
export { prepareTurn, useTurnPipeline, type TurnContext, type TurnMiddleware } from "./runtime/turn.ts";
export { registeredSkills, useSkillRegistry } from "./skills/registry.ts";
export { backgroundJobs, type BackgroundJob } from "./tools/background-jobs.ts";
export { loadCapabilityPlugins, type LoadedCapabilityPlugins } from "./plugins/capability.ts";
export { API_FORMATS, getProvider, streamAssistant, useLlmRegistry } from "./ai/index.ts";
export { sessionHeaders } from "./ai/cache-routing.ts";
export { USER_AGENT } from "./ai/endpoint.ts";
export type { AgentEvent, AgentEventSink, CommandRun, HookRun, QueuedTask } from "./agent/events.ts";
export type { TodoItem } from "./tools/todo.ts";
export { runAgent } from "./agent/loop.ts";
export type {
	AfterToolCall,
	AgentControlContext,
	AgentModelContext,
	AgentRunConfig,
	AgentRunResult,
	AgentSessionContext,
	AgentToolContext,
	BeforeToolCall,
	LiveModel,
	PermissionRequestHook,
	StopHook,
	StreamFn,
	StreamRequest,
	ToolEnvironment,
} from "./agent/run-config.ts";
export { errorResult, textResult } from "./agent/tool-run.ts";
export { runTurn, useAgentLoop, type AgentLoop } from "./agent/runner.ts";
export { runTool, useToolPipeline, type ToolCall, type ToolMiddleware } from "./agent/tool-pipeline.ts";
export {
	availableModels,
	DEFAULT_APPEARANCE,
	DEFAULT_SCREENSHOT_SETTINGS,
	DEFAULT_SETTINGS,
	loadSettings,
	rememberProviderNames,
	resolveModel,
	saveSettings,
	settingsPath,
	type AppearanceSettings,
	type PermissionMode,
	type ScheduledTask,
	type ProjectEntry,
	type ScreenshotSettings,
	type Settings,
	type UiLocale,
	UI_LOCALES,
} from "./config/settings.ts";
/**
 * The credential store, for the desktop's own secrets.
 *
 * Exported from the root because the main process is the only thing that touches it — the renderer
 * never sees a token, which is the point of it living behind IPC.
 */
export { resetVault, seal, secret, unseal } from "./config/vault.ts";
/** Replacing a file whole, for the main process's own files; see `utils/atomic-write.ts`. */
export { renameWithRetry, writeFileAtomic } from "./utils/atomic-write.ts";
export {
	McpManager,
	type McpHttpServer,
	type McpOrigin,
	type McpServerConfig,
	type McpServerStatus,
	type McpStdioServer,
} from "./mcp/client.ts";
export {
	isPlaceholder,
	looksSecret,
	McpMissingValues,
	missingFor,
	needsOf,
	placeholdersOf,
	type McpNeed,
} from "./mcp/placeholders.ts";
export {
	bundleRoot,
	fetchRegistry,
	installEntry,
	uninstallEntry,
	type BundleKind,
	type ClientId,
	type Installed,
	type Registry,
	type RegistryEntry,
} from "./plugins/registry.ts";
export {
	inspectBundle,
	loadPlugins,
	pluginSummary,
	type McpBundle,
	type Plugin,
	type PluginDiagnostic,
	type PluginInterface,
	type PluginManifest,
} from "./plugins/loader.ts";
/*
 * `isOutdated` is also published as `@plume/core/install-record`, and the renderer must use that one.
 * Importing a *value* from this index pulls the whole of it into a browser bundle, which reaches
 * `node:fs` and blanks the window. The type is free either way.
 */
export { isOutdated, readInstalls, type InstallRecord } from "./plugins/installs.ts";
export {
	buildIndex,
	indexStats,
	loadIndex,
	pruneIndexes,
	saveIndex,
	searchIndex,
	type SymbolEntry,
	type SymbolIndex,
} from "./index/symbols.ts";
export { buildSystemPrompt, loadProjectInstructions } from "./prompt/system.ts";
export {
	addMemoryEntry,
	clearAllMemory,
	formatMemoryForPrompt,
	loadMemory,
	memoryPath,
	removeMemoryEntry,
	saveMemory,
	type MemoryEntry,
	type MemoryStore,
} from "./runtime/memory.ts";
export { compactIfNeeded, compactWith, useCompaction } from "./runtime/compaction.ts";
export type { ContextBreakdown, ContextSegment, ContextSegmentKey, MemoryFileItem } from "./runtime/context.ts";
export { estimateTokens } from "./tokens.ts";
export { computeCost, costAtRates, selectPricingRates, type SelectedPricingRates } from "./utils/pricing.ts";
export {
	CACHE_CAUSES,
	CACHE_NOISE_FLOOR_TOKENS,
	diagnoseCache,
	diagnoseRequest,
	markCacheBoundary,
	newCacheDiagnosisState,
	summarizeCacheDiagnoses,
	type CacheBoundary,
	type CacheCause,
	type CacheCauseTotals,
	type CacheDiagnosisState,
	type CacheDiagnosticsOptions,
	type CacheDiagnosticsSummary,
	type CacheRequestDiagnosis,
} from "./runtime/cache-diagnostics.ts";
export {
	HOOK_EVENTS,
	addHook,
	hookEntries,
	readProjectHooks,
	removeHook,
	setHookEnabled,
	updateHook,
	writeProjectHooks,
	type HookDefinition,
	type HookDraft,
	type HookEntry,
	type HookEventName,
	type HookScope,
	type HooksConfig,
} from "./hooks/config.ts";
export { trustHookDigests, trustedHookDigests } from "./hooks/trust.ts";
export { hookCommandDisplay } from "./hooks/runner.ts";
export type { SessionStatus } from "./runtime/reporting.ts";
export { AgentSession, type AgentSessionOptions,  } from "./runtime/session.ts";
export { SideChat, restoredSideChatMessages, type SideAskOptions, type SideChatOptions, type SideChatState, type SideChatEvent, type SideChatUpdate } from "./runtime/sidechat.ts";
export {
	plumeHome,
	projectIdFor,
	SessionStore,
	type SessionMeta,
	type SessionRecord,
} from "./session/store.ts";
export {
	INLINE_IMAGE_CHARS,
	persistSessionImage,
	safeMediaName,
	sessionMediaHome,
	sessionMediaPath,
} from "./session/payload.ts";
export { builtinCommandsFor, BUILTIN_COMMANDS, type BuiltinCommand, type CommandAction } from "./commands/builtin.ts";
export { listCommands, type CommandsList, type SkillEntry } from "./commands/catalogue.ts";
export { resolveInvocation, skillCommandName, type ResolvedInvocation } from "./commands/invoke.ts";
export {
	commandSources,
	loadCommands,
	type CommandDiagnostic,
	type CommandSource,
	type SlashCommand,
} from "./commands/loader.ts";
export {
	expandCommand,
	parseInvocation,
	parseSkillMention,
	rankCommands,
	splitArguments,
	type Invocation,
} from "./commands/expand.ts";
export {
	formatSkillCatalogue,
	formatSkillInvocation,
	loadSkills,
	isUnparsable,
	parseFrontmatter,
	SKILLS_KEY,
	skillTool,
	type Skill,
	type SkillDiagnostic,
} from "./skills/index.ts";
/*
 * 工具与平台这两处从 `export *` 改成点名。
 *
 * `export *` 的代价不是体积，是「加一个导出不需要经过任何人」——而这个文件是根入口，进来的东西
 * 会被渲染进程当成公共 API 用，而渲染进程从根入口取**值**会把整条 `node:fs` 链拉进浏览器包
 * （见 `.dependency-cruiser.cjs` 里那条规则，以及它注明的「先看到过一整屏空白」）。点名之后，
 * 往外开一个口子是一次要写进 diff 的动作。
 *
 * `./types.ts` 留着 `export *`，它不是同一件事：那个文件自己就是类型模型的门（三行转出三个
 * 类型文件），而类型在编译期就擦掉了，不可能被误当成值拉进包里。
 */
export {
	builtinTools,
	READ_ONLY_TOOL_NAMES,
	staticTools,
	useToolRegistry,
	askUserTool,
	bashOutputTool,
	bashTool,
	isReadOnlyCommand,
	formatDiff,
	editTool,
	globToRegExp,
	globTool,
	grepTool,
	invalidateIndex,
	symbolTool,
	lsTool,
	recallTool,
	displayPath,
	resolveWorkspacePath,
	hasRead,
	markRead,
	readTool,
	AGENTS_KEY,
	BUILTIN_AGENTS,
	taskTool,
	previewTool,
	readTodos,
	todoTool,
	TODOS_KEY,
	htmlToText,
	webFetchTool,
	webSearchTool,
	writeTool,
	type AgentDefinition,
	type DiffHunk,
	type DiffLine,
	type FileDiff,
} from "./tools/index.ts";
// Every risk rule's code with its own wording — what a host's translations of `risk.<code>` cover.
export { RISK_REASONS } from "./tools/risk-reasons.ts";
export { home, systemShell, within, withinOrIs } from "./platform.ts";
export * from "./types.ts";
export {
	listPreviews,
	pruneSessionArtifacts,
	prunePreviews,
	previewsHome,
	readPreview,
	removePreviews,
	removeSessionArtifacts,
	scratchHome,
	writePreview,
	type PreviewFile,
	type PreviewRecord,
} from "./runtime/previews.ts";

export type { SubAgentDetail } from "./runtime/sub-agents.ts";
export type { SubAgentStatus, SubAgentSummary } from "./types/sub-agent.ts";
export { collectAgents, collectSkills, disabledSkillMatcher } from "./runtime/session-setup.ts";
export {
	approveSkill,
	managedSkillsDir,
	pendingSkills,
	proposeSkill,
	rejectSkill,
	type SkillCandidate,
} from "./runtime/managed-skills.ts";
export {
	resolveModelThinkingOptions,
	resolveReasoningEffort,
	resolveThinkingOption,
	thinkingOptionsFor,
	DEFAULT_THINKING_OPTIONS,
	THINKING_LEVELS,
} from "./ai/thinking-options.ts";
export { lastPassAt, PASS_INTERVAL_MS, runMemoryPass, shouldRunPass } from "./runtime/memory-pass.ts";
export {
	MODEL_ROLES,
	ROLE_DESCRIPTIONS,
	parseModelRef,
	resolveModelRef,
	roleStatus,
	type ModelRole,
} from "./config/model-roles.ts";
export { layerOverrides, loadProjectLayer, projectConfigPath, type LayerOverride } from "./config/layers.ts";
export { extensionDirs } from "./runtime/session-capabilities.ts";
export { validateManifest, type ExtensionDiagnostic, type ExtensionEventStats, type ExtensionStats } from "./extensions/types.ts";
export { annotateInjected, EXTRACTED_KEY, projectInjectedPath, readInjected, userInjectedPath } from "./runtime/memory-injected.ts";
export { readLessons } from "./runtime/project-memory.ts";
export { forgetAllLessons, forgetExtractedMemory, forgetLesson, writeLessons } from "./runtime/project-memory.ts";
export { readExtractedMemory } from "./runtime/memory-extract.ts";
export { projectMemoryDir } from "./runtime/project-memory.ts";
export { computeDiff } from "./tools/diff.ts";

export { readFileChange, undoFileChanges, undoFileChangeBatches, type RecordedChange } from "./tools/file-changes.ts";
export { AgentDefinitionStore } from "./agents/definition-store.ts";
export type { AgentDraft, AgentDefinitionRecord, AgentDefinitionSave } from "./agents/definition-document.ts";

/*
 * 一份文档里的字。
 *
 * `read` 工具靠它把 `.docx`、`.xlsx`、`.pptx`、`.pdf` 读成字而不是拒掉——这些格式底下是 zip 加 XML，
 * 字就在里面。桌面端把同一份实现用在「拖进输入框」那条路上：同一份文件、同样的字节，不该因为是谁在
 * 问而给出两种答案。
 */
export { EXTRACTABLE, extractDocumentText, textFromPdf, type ExtractedText } from "./files/document-text.ts";
