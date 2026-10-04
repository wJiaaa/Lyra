/**
 * What the phone is allowed to ask the desktop to do.
 *
 * The phone runs the desktop's own renderer — the same React app, the same components, the same
 * settings pages — and that renderer talks to `window.plume`, an interface of some 199 methods. On
 * the desktop those are Electron IPC channels. Over the network they cannot all be: `terminal.*`
 * hands out a shell, `files.write` writes anywhere the user can, `screenshot.*` reads the display.
 *
 * So this is an allowlist rather than a bridge. A method that is not named here does not exist for
 * the phone, and the renderer degrades on its own — a settings page whose data never arrives shows
 * its empty state, which is the right thing for a page that has no business being on a phone.
 *
 * **说清楚这份名单挡的是什么，不挡什么。**
 *
 * 它挡的是「手机能调哪些方法」，不是「拿到配对令牌的人能做多少事」。这两件事之间的距离是有意
 * 留下的：手机可以写 `permissionMode`（见 `phone-settings.ts`——在手机上批准本来就是这个功能
 * 存在的理由），设成 `full` 之后审批全部放行、沙箱变 `danger-full-access`；而 `agent.prompt`
 * 在名单里。也就是说，名单里没有 `terminal.*`，但一把令牌仍然可以让 agent 在一个项目里跑任意
 * 命令——**这是产品意图，不是漏洞**。配对令牌要按「能操作这台机器」来保管，不是按「能看会话」。
 *
 * 这段话是 2026-09-12 改的。原文写的是「Whoever holds the pairing token would hold all of it」，
 * 把这件事说成了要防的事——而代码从来没有防，也不打算防。一份自述与现状不符的安全边界，比没有
 * 自述更糟：照着它做判断的人会以为令牌泄露的后果只到「会话被人看见」。
 *
 * 真正收紧的是另外两处：`sessions.create` 的 cwd 现在必须落在已打开的项目里（见 `sync.ts` 的
 * `create`），以及 `sync-server.ts` 里那七条绕过本名单的旧 HTTP 写路由已经删掉。
 *
 * The list is the security boundary for *method reach* and the product decision at once, which is
 * why it is one file you can read top to bottom rather than a rule spread across the handlers.
 */

import {
	forkBeforeMessage,
	forkSession,
	readTrajectory,
	withinOrIs,
	type AgentSession,
	type SessionStorage,
	type Settings,
	type ThinkingLevel,
	type UserContent,
} from "@plume/core";
import type { PlumeApi } from "./ipc-types.ts";
import { resolveSessionApproval } from "./approval-response.ts";
import { readTrajectoryChanges } from "./trajectory-changes.ts";
import { initialPrompt, promptContent, promptOptions } from "./prompt-input.ts";
import { settingsForPhone, settingsFromPhone } from "./phone-settings.ts";
import { scratchRoots } from "./scratch.ts";
import {
	all,
	bool,
	content,
	index,
	nullableStr,
	oneOf,
	optionalStr,
	path,
	record,
	str,
	text,
	type ArgsError,
	type Checked,
} from "@plume/contract/args";
import { REMOTE_METHODS, methodFor } from "@plume/contract";
import { slimSnapshot } from "./display-transcript.ts";

/**
 * Everything a call may reach, handed in rather than imported.
 *
 * The session hub reaches Electron through its own imports, and this module is otherwise plain
 * data — importing it here would make the allowlist unloadable outside Electron, which is exactly
 * where its tests want to run. Injection keeps this file a list of decisions rather than a graph
 * of dependencies.
 */
export interface RpcDeps {
	store(): SessionStorage;
	settings(): Settings;
	saveSettings(next: Settings): Promise<void>;
	workspaceInfo(path: string): Promise<unknown>;
	/** Sessions currently warm, by id. */
	live(sessionId: string): AgentSession | undefined;
	/** Bring a stored session up, or null when there is no such session. */
	activate(sessionId: string): Promise<AgentSession | null>;
	create: PlumeApi["sessions"]["create"];
	prompt: PlumeApi["agent"]["prompt"];
	editMessage: PlumeApi["agent"]["editMessage"];
	revertMessage: PlumeApi["agent"]["revertMessage"];
	abort(sessionId: string): Promise<void>;
	dispose(sessionId: string): Promise<void>;
	snapshot(session: AgentSession): Promise<unknown>;
	/** Stop and delete, refusing new work on them until they are gone. See `deleteSessions`. */
	remove(sessionIds: string[]): Promise<void>;
	touch(sessionId: string): void;
	sideChatState: PlumeApi["sideChat"]["state"];
	sideChatSetModel: PlumeApi["sideChat"]["setModel"];
	sideChatAsk: PlumeApi["sideChat"]["ask"];
	sideChatEditAndResend: PlumeApi["sideChat"]["editAndResend"];
	sideChatAbort: PlumeApi["sideChat"]["abort"];
	sideChatReset: PlumeApi["sideChat"]["reset"];
	sideChatClose: PlumeApi["sideChat"]["close"];
	tasksList: PlumeApi["tasks"]["list"];
	tasksCancel: PlumeApi["tasks"]["cancel"];
	tasksDismiss: PlumeApi["tasks"]["dismiss"];
	tasksResume: PlumeApi["tasks"]["resume"];
	commandsList: PlumeApi["commands"]["list"];
	filesList: PlumeApi["files"]["list"];
	filesRead: PlumeApi["files"]["read"];
	scratchRoots: PlumeApi["git"]["scratchRoots"];
	generalScratch: PlumeApi["git"]["generalScratch"];
	/** A finished upload from the phone — by id, or by the path it was given — as its path here; see `sync-uploads.ts`. */
	uploadPath?(idOrPath: string): string | null;
}

type Handler = (deps: RpcDeps, args: unknown[]) => Promise<unknown>;

const s = (value: unknown): string => (typeof value === "string" ? value : "");
/** 侧边聊天只认这一个选项——校验已经在 `optionalRecord` 那边做过了。 */
const thinkingOnly = (value: unknown): { thinking?: ThinkingLevel } | undefined => {
	const level = (value as { thinking?: unknown } | null | undefined)?.thinking;
	return typeof level === "string" ? { thinking: level as ThinkingLevel } : undefined;
};
/** 一句操控：一段字，或者一串内容块。校验已经在 `content` 那边做过了。 */
const said = (value: unknown): string | UserContent[] => (typeof value === "string" ? value : Array.isArray(value) ? (value as UserContent[]) : "");

/**
 * Everything the phone may call, and nothing else.
 *
 * Grouped by why each one is here rather than alphabetically — the interesting question about any
 * of these is "should a phone be able to do this", and grouping by answer makes the omissions
 * visible. What is deliberately absent: `terminal` (a shell), `files.write` (arbitrary writes),
 * `screenshot` (reads the display), `git` beyond reading, `plugins`, `updates`, `system.openPath`.
 */
export const RPC: Record<string, Handler> = {
	// -- Reading the shell -----------------------------------------------------
	"settings.get": async (deps) => settingsForPhone(deps.settings()),
	"sessions.list": async (deps) => deps.store().listSessions(),
	/*
	 * 这个会话此刻在不在跑——权威那一份。
	 *
	 * 手机端和桌面端一样，运行状态是一串事件推出来的，丢一条就永久停在「正在跑」上；而手机的连接
	 * 更容易断，所以它比桌面更需要能对一次账。只答一个布尔，不带转录。
	 */
	"sessions.running": async (deps, [sessionId]) => deps.live(s(sessionId))?.running ?? false,
	"workspace.info": async (deps, [path]) => deps.workspaceInfo(s(path)),

	// -- Opening and reading a conversation ------------------------------------
	"sessions.transcript": async (deps, [sessionId]) => {
		// A live session is the authority: it holds the messages of a turn still in flight.
		const warm = deps.live(s(sessionId));
		if (warm) {
			deps.touch(s(sessionId));
			return deps.snapshot(warm);
		}
		const loaded = await deps.store().load(s(sessionId), { display: true });
		if (!loaded) return null;
		return slimSnapshot({
			meta: loaded.meta,
			messages: loaded.messages,
			running: false,
			pendingApprovals: [],
			compactions: loaded.compactions,
			commandRuns: loaded.commandRuns,
			hookRuns: loaded.hookRuns,
		});
	},
	"sessions.open": async (deps, [sessionId]) => {
		const session = await deps.activate(s(sessionId));
		return session ? deps.snapshot(session) : null;
	},
	"sessions.trajectory": async (deps, [sessionId]) =>
		readTrajectory(deps.store(), s(sessionId), deps.live(s(sessionId))?.running ?? false),
	"sessions.trajectoryChanges": async (deps, [sessionId, cursor]) =>
		readTrajectoryChanges(deps.store(), s(sessionId), typeof cursor === "string" ? cursor : undefined, deps.live(s(sessionId))?.running ?? false),
	"sessions.fork": async (deps, [sessionId, seq]) =>
		forkSession(deps.store(), s(sessionId), Number(seq)),
	"sessions.forkBefore": async (deps, [sessionId, messageIndex, timestamp, title]) =>
		forkBeforeMessage(deps.store(), s(sessionId), Number(messageIndex), Number(timestamp), typeof title === "string" ? title : undefined),
	"sessions.create": async (deps, [cwd, modelId, initial]) =>
		// "remote"：对面递来的附件路径不作数，见 `prompt-input.ts` 的 `PromptOrigin`。
		deps.create(s(cwd), s(modelId), initialPrompt(initial, "remote", deps.uploadPath)),

	// -- Driving a turn --------------------------------------------------------
	"agent.prompt": async (deps, [sessionId, content, options]) =>
		deps.prompt(s(sessionId), promptContent(content), promptOptions(options, "remote", deps.uploadPath)),
	"agent.abort": async (deps, [sessionId]) => {
		await deps.abort(s(sessionId));
		return null;
	},
	"agent.approve": async (deps, [sessionId, requestId, decision]) => {
		const session = deps.live(s(sessionId));
		if (!session) throw new Error("Invalid or expired approval response");
		await resolveSessionApproval(session, s(requestId), decision, async subject => {
			const current = deps.settings();
			if (!current.alwaysAllow.includes(subject)) await deps.saveSettings({ ...current, alwaysAllow: [...current.alwaysAllow, subject] });
		});
		return null;
	},
	"agent.setModel": async (deps, [sessionId, modelId]) => {
		const session = await deps.activate(s(sessionId));
		await session?.setModel(s(modelId));
		return null;
	},
	"agent.setThinking": async (deps, [sessionId, thinking]) => {
		const session = await deps.activate(s(sessionId));
		await session?.setThinking(thinkingLevel(thinking));
		return null;
	},
	/*
	 * 只收该收的两样。
	 *
	 * `promptOptions` 是给 `agent.prompt` 准备的，认得出的字段比这里多。编辑重发要带过来的只有
	 * 「这条消息除措辞之外的样子」——附了哪几个文件，气泡里该显示什么；投递方式、synthetic 这些
	 * 是「怎么发出去」，由这一次编辑自己决定，不该由对面说了算。
	 */
	"agent.editMessage": async (deps, [sessionId, index, content, options]) => {
		const { displayText, attachments } = promptOptions(options, "remote", deps.uploadPath);
		return deps.editMessage(s(sessionId), Number(index), promptContent(content), {
			...(displayText === undefined ? {} : { displayText }),
			...(attachments === undefined ? {} : { attachments }),
		});
	},
	"agent.revertMessage": async (deps, [sessionId, index]) =>
		deps.revertMessage(s(sessionId), Number(index)),

	"sessions.compact": async (deps, [sessionId, instructions]) => {
		const session = await deps.activate(s(sessionId));
		if (!session) return { ok: false, reason: "找不到这个会话。" };
		return session.compact(typeof instructions === "string" ? instructions : undefined);
	},
	"sessions.contextBreakdown": async (deps, [sessionId]) => {
		const session = await deps.activate(s(sessionId));
		return session ? session.contextBreakdown() : null;
	},

	// -- Managing the list -----------------------------------------------------
	/*
	 * Writable, unlike most of the desktop's reach. Renaming, archiving and deleting a conversation
	 * are things about *this app's own data* — the kind of tidying someone does on a phone — rather
	 * than reach into the machine. Writing files or opening a shell is the line, and it is drawn
	 * by what is absent from this list.
	 */
	"sessions.rename": async (deps, [sessionId, title]) => {
		const clean = s(title).trim();
		if (!clean) return null;
		const session = deps.live(s(sessionId));
		if (session) {
			await session.rename(clean);
			return session.meta;
		}
		const meta = await deps.store().get(s(sessionId));
		if (!meta) return null;
		return deps.store().append(meta, { type: "title", title: clean, source: "user" });
	},
	"sessions.setArchived": async (deps, [sessionId, archived]) => {
		if (archived) await deps.dispose(s(sessionId));
		await deps.store().setArchived(s(sessionId), Boolean(archived));
		return deps.store().listSessions();
	},
	/*
	 * 换个项目归属，规矩和桌面那条一样（见 `ipc/sessions.ts` 的 `sessions:move`）：正在跑的拒绝，
	 * 其余的先把活着的那个停掉再搬——它攥着旧的 cwd，接着跑会在旧目录里动手。
	 *
	 * 多一道桌面端没有的关：**目标只能是这台机器已经认识的目录**。
	 *
	 * 会话的 cwd 就是下一次对话开工的地方，而这个参数是从一部手机上来的。桌面端的菜单只列得出
	 * 已配置的项目，手机发来的却是一个字符串——不拦的话，一部被拿走的手机可以把某条对话的工作
	 * 目录指到这台机器上的任何地方，下次有人接着聊，agent 就在那儿动手了。这条清单这一侧的界线
	 * 写在文件开头：整理这个应用自己的数据可以，伸进这台机器不行。
	 */
	"sessions.move": async (deps, [sessionId, cwd, projectName]) => {
		const id = s(sessionId);
		const target = s(cwd);
		/*
		 * 配置里的项目按原样比对；那几个 workspace 目录连它们底下的东西一起算——「不在项目中工作」
		 * 用的是根底下的 `general/`，PR 评审用的是 `owner-repo-6381/`，都不是根本身。用 `withinOrIs`
		 * 而不是比前缀：`workspaces/../../etc` 也以 `workspaces/` 开头，而它显然不在里面。
		 */
		const known =
			deps.settings().projects.some((project) => project.path === target) ||
			scratchRoots().some((root) => withinOrIs(root, target));
		if (!known) return { ok: false, reason: "failed", message: "目标不在这台机器已知的项目里" };
		if (deps.live(id)?.running) return { ok: false, reason: "running" };
		await deps.dispose(id);
		try {
			const meta = await deps.store().move(id, target, s(projectName));
			return meta ? { ok: true, meta } : { ok: false, reason: "gone" };
		} catch (cause) {
			return { ok: false, reason: "failed", message: cause instanceof Error ? cause.message : String(cause) };
		}
	},
	"sessions.remove": async (deps, [sessionId]) => {
		await deps.remove([s(sessionId)]);
		return null;
	},
	/*
	 * Merged onto what the desktop has, rather than replacing it — see `phone-settings.ts`.
	 *
	 * Taking the object as sent meant two things at once: a phone could write `hooks`, which is a
	 * list of shell commands the desktop runs, and a phone one version behind could drop every
	 * field it did not know about.
	 */
	"settings.save": async (deps, [next]) => {
		await deps.saveSettings(settingsFromPhone(deps.settings(), next));
		return settingsForPhone(deps.settings());
	},

	// -- Things the renderer asks for and can live without ---------------------
	/*
	 * Answered rather than omitted, because the renderer calls them on its startup path and an
	 * allowlist rejection would surface as an error where the honest answer is "not here".
	 * Scratch directories are a desktop concept: they are folders on that machine.
	 */
	"git.scratchRoots": async (deps) => deps.scratchRoots(),
	"git.generalScratch": async (deps) => deps.generalScratch(),
	"subAgents.list": async (deps, [sessionId]) => deps.live(s(sessionId))?.subAgents.list() ?? [],
	"subAgents.detail": async (deps, [sessionId, id]) => deps.live(s(sessionId))?.subAgents.detail(s(id)) ?? null,
	"subAgents.steer": async (deps, [sessionId, id, message]) => deps.live(s(sessionId))?.steerSubAgent(s(id), said(message)) ?? false,
	"subAgents.abort": async (deps, [sessionId, id]) => deps.live(s(sessionId))?.abortSubAgent(s(id)) ?? false,
	"subAgents.dismiss": async (deps, [sessionId, id]) => deps.live(s(sessionId))?.dismissSubAgent(s(id)) ?? "unknown",
	"sideChat.setModel": async (deps, [sessionId, sideId, modelId]) => deps.sideChatSetModel(s(sessionId), s(sideId), modelId === null ? null : s(modelId)),
	"sideChat.state": async (deps, [sessionId, sideId]) => deps.sideChatState(s(sessionId), s(sideId)),
	"sideChat.ask": async (deps, [sessionId, sideId, content_, options]) => deps.sideChatAsk(s(sessionId), s(sideId), promptContent(content_), thinkingOnly(options)),
	"sideChat.editAndResend": async (deps, [sessionId, sideId, messageIndex, content_]) =>
		deps.sideChatEditAndResend(s(sessionId), s(sideId), Number(messageIndex), promptContent(content_)),
	"sideChat.abort": async (deps, [sessionId, sideId]) => deps.sideChatAbort(s(sessionId), s(sideId)),
	"sideChat.reset": async (deps, [sessionId, sideId]) => deps.sideChatReset(s(sessionId), s(sideId)),
	"sideChat.close": async (deps, [sessionId, sideId]) => deps.sideChatClose(s(sessionId), s(sideId)),
	"tasks.list": async (deps, [sessionId]) => deps.tasksList(s(sessionId)),
	"tasks.cancel": async (deps, [sessionId, taskId]) => deps.tasksCancel(s(sessionId), s(taskId)),
	"tasks.dismiss": async (deps, [sessionId, taskId]) => deps.tasksDismiss(s(sessionId), s(taskId)),
	"tasks.resume": async (deps, [sessionId, taskId]) => deps.tasksResume(s(sessionId), s(taskId)),
	"commands.list": async (deps, [cwd]) => deps.commandsList(typeof cwd === "string" ? cwd : ""),
	"files.list": async (deps, [dir]) => deps.filesList(s(dir)),
	"files.read": async (deps, [path_]) => deps.filesRead(s(path_)),
	/*
	 * The same shape the desktop reports, read off the live session.
	 *
	 * Null when the session is not warm, exactly as on the desktop: this is a question about a
	 * running agent, and starting one to answer it would make opening a conversation on the phone
	 * pay for skills, plugins and MCP child processes it may never use.
	 */
	"sessions.capabilities": async (deps, [sessionId]) => {
		const session = deps.live(s(sessionId));
		if (!session) return null;
		deps.touch(s(sessionId));
		const status = await session.status();
		return {
			skills: status.skills,
			skillDiagnostics: status.skillDiagnostics,
			plugins: status.plugins,
			pluginDiagnostics: status.pluginDiagnostics,
			mcp: status.mcp,
			agents: status.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				source: agent.source,
				model: agent.model,
				tools: agent.tools,
				...(agent.avatar ? { avatar: agent.avatar } : {}),
			})),
			toolNames: status.toolNames,
		};
	},
};

export interface RpcResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

/**
 * Run one call, or say why not.
 *
 * Errors come back as a value rather than a thrown exception, so a method that fails leaves the
 * connection alone — the phone is a long-lived client and one bad call should not cost it the
 * WebSocket and the resync that follows.
 */
/**
 * What each method's arguments have to be, checked before the handler sees them.
 *
 * These are the only arguments in the application that did not come from our own renderer — they
 * arrived on a WebSocket. Until now the only handling was `s(value)`, which turns anything that is
 * not a string into `""`; a number, an object or a null went through as empty string and became a
 * lookup for a session named "". The request was never refused, it just failed later somewhere
 * that had nothing to do with the caller.
 *
 * A method missing from this table is refused outright rather than allowed through unchecked, so
 * adding to `RPC` without adding here fails closed. `test/sync-rpc-args.test.ts` asserts the two
 * lists match.
 */
const ARGS: Record<string, (args: unknown[]) => ArgsError | null> = {
	"settings.get": () => null,
	"sessions.list": () => null,
	"git.generalScratch": () => null,
	"git.scratchRoots": () => null,

	"workspace.info": ([path_]) => fail(path(path_, "path")),
	"sessions.fork": ([sessionId, seq]) => fail(all(str(sessionId, "sessionId"), index(seq, "seq"))),
	"sessions.forkBefore": ([sessionId, messageIndex, timestamp, title]) =>
		fail(all(str(sessionId, "sessionId"), index(messageIndex, "messageIndex"), index(timestamp, "timestamp"), optionalStr(title, "title", 1_000))),
	"sessions.create": ([cwd, modelId]) => fail(all(path(cwd, "cwd"), optionalStr(modelId, "modelId"))),
	"sessions.open": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"sessions.running": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"sessions.transcript": ([sessionId]) =>
		fail(str(sessionId, "sessionId")),
	"sessions.trajectory": ([sessionId]) =>
		fail(str(sessionId, "sessionId")),
	"sessions.trajectoryChanges": ([sessionId, cursor]) =>
		fail(all(str(sessionId, "sessionId"), optionalStr(cursor, "cursor"))),
	"sessions.remove": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"sessions.capabilities": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"sessions.setArchived": ([sessionId, archived]) =>
		fail(all(str(sessionId, "sessionId"), bool(archived, "archived"))),
	"sessions.rename": ([sessionId, title]) =>
		fail(all(str(sessionId, "sessionId"), text(title, "title"))),
	/*
	 * `cwd` 走 `path` 而不是 `str`：它是一个会被当成目录用的字符串。
	 *
	 * 这一层只管形状，「是不是这台机器认识的目录」在 handler 里问——那句话需要 settings，而这张
	 * 表只看得见参数。
	 */
	"sessions.move": ([sessionId, cwd, projectName]) =>
		fail(all(str(sessionId, "sessionId"), path(cwd, "cwd"), text(projectName, "projectName"))),
	"sessions.compact": ([sessionId, instructions]) =>
		fail(all(str(sessionId, "sessionId"), optionalStr(instructions, "instructions", 20_000))),
	"sessions.contextBreakdown": ([sessionId]) => fail(str(sessionId, "sessionId")),

	"agent.prompt": ([sessionId, content_, options]) =>
		fail(all(str(sessionId, "sessionId"), content(content_, "content"), optionalRecord(options, "options"))),
	"agent.editMessage": ([sessionId, messageIndex, content_, options]) =>
		fail(all(str(sessionId, "sessionId"), index(messageIndex, "messageIndex"), content(content_, "content"), optionalRecord(options, "options"))),
	"agent.revertMessage": ([sessionId, messageIndex]) =>
		fail(all(str(sessionId, "sessionId"), index(messageIndex, "messageIndex"))),
	"agent.abort": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"agent.approve": ([sessionId, requestId, decision]) =>
		fail(all(str(sessionId, "sessionId"), str(requestId, "requestId"), checkApprovalDecision(decision))),
	"agent.setModel": ([sessionId, modelId]) => fail(all(str(sessionId, "sessionId"), str(modelId, "modelId"))),
	"agent.setThinking": ([sessionId, thinking]) => fail(all(str(sessionId, "sessionId"), nullableStr(thinking, "thinking"))),

	/*
	 * `settings.save` takes the whole settings object, and `phone-settings.ts` is what decides
	 * which fields of it are actually applied — that allowlist is the security boundary here, and
	 * it stays where it is. This only checks that an object arrived at all.
	 */
	"settings.save": ([next]) => fail(record(next, "settings")),
	"subAgents.list": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"subAgents.detail": ([sessionId, id]) => fail(all(str(sessionId, "sessionId"), str(id, "id"))),
	// 字符串或内容块都收：操控框现在也能附图，而手机端发的仍然是一段字。
	"subAgents.steer": ([sessionId, id, message]) =>
		fail(all(str(sessionId, "sessionId"), str(id, "id"), content(message, "message"))),
	"subAgents.abort": ([sessionId, id]) => fail(all(str(sessionId, "sessionId"), str(id, "id"))),
	"subAgents.dismiss": ([sessionId, id]) => fail(all(str(sessionId, "sessionId"), str(id, "id"))),
	"sideChat.setModel": ([sessionId, sideId, modelId]) => fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"), nullableStr(modelId, "modelId"))),
	"sideChat.state": ([sessionId, sideId]) => fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"))),
	"sideChat.ask": ([sessionId, sideId, content_, options]) =>
		fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"), content(content_, "content"), optionalRecord(options, "options"))),
	"sideChat.editAndResend": ([sessionId, sideId, messageIndex, content_]) =>
		fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"), index(messageIndex, "messageIndex"), content(content_, "content"))),
	"sideChat.abort": ([sessionId, sideId]) => fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"))),
	"sideChat.reset": ([sessionId, sideId]) => fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"))),
	"sideChat.close": ([sessionId, sideId]) => fail(all(str(sessionId, "sessionId"), str(sideId, "sideId"))),
	"tasks.list": ([sessionId]) => fail(str(sessionId, "sessionId")),
	"tasks.cancel": ([sessionId, taskId]) => fail(all(str(sessionId, "sessionId"), str(taskId, "taskId"))),
	"tasks.dismiss": ([sessionId, taskId]) => fail(all(str(sessionId, "sessionId"), str(taskId, "taskId"))),
	"tasks.resume": ([sessionId, taskId]) => fail(all(str(sessionId, "sessionId"), str(taskId, "taskId"))),
	"commands.list": ([cwd]) => fail(text(cwd, "cwd")),
	"files.list": ([dir]) => fail(path(dir, "dir")),
	"files.read": ([path_]) => fail(path(path_, "path")),
};

function checkApprovalDecision(value: unknown): Checked<unknown> {
	if (typeof value === "object" && value !== null && "answer" in value) {
		if (Array.isArray(value.answer)) {
			if (!value.answer.length || value.answer.length > 100) return str(undefined, "decision.answer");
			return all(...value.answer.map((answer: unknown) => str(answer, "decision.answer", 20_000)));
		}
		return str(value.answer, "decision.answer", 20_000);
	}
	return oneOf(value, "decision", ["once", "always", "reject", "skip"]);
}

function thinkingLevel(value: unknown): ThinkingLevel | null {
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error("invalid thinking level");
}

/** `undefined` is fine, anything else has to be an object. */
function optionalRecord(value: unknown, name: string) {
	return value === undefined || value === null ? ({ ok: true, value: undefined } as const) : record(value, name);
}

/** Unwrap a check into "the error, or nothing". */
function fail(checked: Checked<unknown>): ArgsError | null {
	return checked.ok ? null : checked;
}

export async function callRpc(deps: RpcDeps, method: string, args: unknown[]): Promise<RpcResult> {
	const handler = RPC[method];
	if (!handler) return { ok: false, error: "method-not-allowed" };

	/*
	 * Checked before the handler runs, and a method with no entry is refused rather than trusted —
	 * so a new method in `RPC` without a matching spec fails closed instead of silently accepting
	 * whatever is on the wire.
	 */
	const check = ARGS[method];
	if (!check) return { ok: false, error: "invalid-args" };
	const problem = check(args);
	if (problem) return { ok: false, error: `invalid-args: ${problem.detail}` };

	try {
		return { ok: true, value: (await handler(deps, args)) ?? null };
	} catch (cause) {
		return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * The methods the phone may call.
 *
 * Read off `RPC`, then checked against the contract — the two are written separately (one is an
 * implementation, one is a declaration) and this is where they have to agree.
 *
 * Checked at startup rather than only in a test, because the two ways they can disagree fail very
 * differently. A method in `RPC` that the contract does not mark `remote` is a hole: the phone can
 * call something nobody declared it could. A method the contract marks `remote` with no
 * implementation is dead: the phone's interface offers it and the call comes back
 * "method-not-allowed", silently, in a place nobody is looking.
 *
 * The first is a security question and throwing is the right answer — a desktop that would serve
 * an undeclared method should not start its sync server at all. The second is a bug and is logged:
 * refusing to start over it would take the whole feature down for something the user cannot act on.
 */
export function allowedMethods(): string[] {
	const implemented = Object.keys(RPC).sort();

	const undeclared = implemented.filter((method) => methodFor(method)?.remote !== true);
	if (undeclared.length > 0) {
		throw new Error(
			`sync-rpc 实现了契约没有标 remote 的方法：${undeclared.join(", ")}。` +
				`把它们加进 packages/contract/src/methods.ts 并写明为什么手机可以调，或者从 RPC 里去掉。`,
		);
	}

	const unimplemented = REMOTE_METHODS.filter((method) => !(method in RPC));
	if (unimplemented.length > 0) {
		console.error(`[sync] 契约标了 remote 但没有实现：${unimplemented.join(", ")}——手机调用它们会静默失败`);
	}

	return implemented;
}
