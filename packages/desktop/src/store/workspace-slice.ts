/**
 * Which project the app is pointed at.
 *
 * Opening a workspace is not just a path: it decides which sessions are listed, which paths every
 * guard will accept, and what the sidebar shows. So these actions all end by refreshing the same
 * few pieces of state, and they are together because forgetting one of them is the bug.
 */

import { translate } from "../i18n/translate.ts";
import type { SessionMeta } from "@plume/core";
import type { AppState } from "./index.ts";
import { useSubAgents } from "./subAgents.ts";
import { bridge } from "../services/index.ts";
import { moveBeforeOrAfter, orderedSessions, type SessionSortKey } from "../lib/sidebar-order.ts";
import { baseName } from "../lib/paths.ts";
import { projectSessions } from "../lib/project-identity.ts";
import { sessionWorkspace } from "./session-workspace.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/** Paths being read for `describeWorkspace`: every screen on one project asks at once. */
const describing = new Set<string>();

export function workspaceSlice(set: Set, get: Get) {
  return {
  async pickWorkspace() {
    const workspace = await bridge.workspace.pick();
    if (!workspace) return;
    await get().openWorkspace(workspace.path);
  },

  async openWorkspace(path: string, projectId?: string) {
    const epoch = get().selectionEpoch + 1;
    set({ selectionEpoch: epoch });
    const workspace = await bridge.workspace.info(path);
    // A newer pick already won; it owns the screen and this one says nothing.
    if (get().selectionEpoch !== epoch) return;
    /*
     * The folder is gone from disk, and saying so is the whole point.
     *
     * `workspace.info` answers `null` for a path that no longer exists, and returning on it
     * silently made a deleted project the one entry in the list that does nothing when clicked —
     * no panel, no error, no hint that the directory is what changed. People read that as the app
     * being stuck on it, which is where 「删不掉」 comes from as much as anywhere: you cannot even
     * get far enough to be told why. Naming the missing folder points at the remove action, which
     * works whether or not the directory is still there.
     */
    if (!workspace) {
      get().notify(translate("workspace.missing", { path }), "error");
      return;
    }

    /*
     * On screen first, remembered second.
     *
     * The project list is written to disk and broadcast to every window, and none of that is
     * anything the person who just picked a folder is waiting to see. Awaiting it before touching
     * state meant the sidebar, the composer's chip and the panels all stayed on the *previous*
     * project until the write came back — a visible pause on the one click whose entire content is
     * "show me this one now".
     */
    const view = get().view;
    /*
     * The other half of "a project keeps the name it was given".
     *
     * `workspaceInfo` reads the directory and can only answer with its `basename`; the name the
     * user typed lives on the project entry. The header, the composer's chip and the git panel all
     * read `workspace`, so a rename that only reached settings showed up in the sidebar and nowhere
     * else — see `renameProject`, which has been patching this one case up by hand.
     */
    /*
     * Which project, not only which folder: one folder can be in several projects, and the one
     * picked is the one whose name the header shows and whose 「最近打开」 moves. Without an id — a
     * folder opened rather than a project chosen — it is no project, even when some project lists
     * that folder: conversations started here belong to none and sit in 「最近」.
     */
    const project = projectId ? get().settings?.projects.find((entry) => entry.id === projectId) : undefined;
    set({ scratchCwd: null, workspace: project ? { ...workspace, name: project.name, projectId: project.id } : workspace });
    // Park the previous session and finish resetting before the new draft can accept a send.
    await get().newSession();
    // Workspace pickers also serve settings and PR views; selecting a folder does not leave them.
    set({ view });

    /*
     * Opening a project updates when it was opened. Opening a folder writes nothing.
     *
     * Every folder opened used to be registered as a project, named after itself — so a project was
     * whatever directory had been visited, not something anyone made. 「新建项目」 is the one way in.
     * Spreading the entry keeps whatever is on it; rebuilding it from `workspace.name` (the folder's
     * basename) once reverted every renamed project on the next switch.
     */
    const settings = get().settings;
    if (!settings || !project) return;
    await get().saveSettings({
      ...settings,
      // Opening a project updates its recency without undoing an explicit list order.
      projects: settings.projects.map((entry) => (entry.id === project.id ? { ...entry, lastOpenedAt: Date.now() } : entry)),
    });
  },

  setSwitchingBranch(switchingBranch: { path: string; branch: string } | null) {
    set({ switchingBranch });
  },

  async refreshWorkspace(path?: string) {
    const target = path ?? get().workspace?.path;
    if (!target) return;
    // The open conversation's own worktree is read as one: named for its project (`sessionWorkspace`).
    const meta = get().meta;
    const workspace = meta?.worktree && meta.cwd === target ? await sessionWorkspace(meta) : await bridge.workspace.info(target);
    if (!workspace) return;
    // A refresh is git's news, not a change of project: the folder only knows its basename, and two projects can share it.
    const current = get().workspace;
    if (current?.path === target) set({ workspace: { ...workspace, name: current.name, ...(current.projectId ? { projectId: current.projectId } : {}) } });
    /*
     * And the copy the other screens read, when a screen named the project.
     *
     * A screen away from the live slot names its project from `workspaceByPath`. Re-reading only the
     * live slot left a switch made under that screen unsaid there — its chip kept the branch git had
     * already left — and, with both screens on one repository, left the two chips disagreeing.
     */
    if (path !== undefined) set({ workspaceByPath: { ...get().workspaceByPath, [target]: workspace } });
  },

  async describeWorkspace(path: string) {
    if (describing.has(path)) return;
    describing.add(path);
    try {
      const workspace = await bridge.workspace.info(path);
      if (!workspace) return;
      // The folder's own name: a screen naming a conversation's project takes it from the conversation (`useScopedWorkspace`).
      set({ workspaceByPath: { ...get().workspaceByPath, [path]: workspace } });
    } catch {
      // A screen without its branch still names its project from the conversation; nothing to report.
    } finally {
      describing.delete(path);
    }
  },

  /**
   * 「不在项目中工作」 — which now means something rather than nothing.
   *
   * It used to only blank the workspace, and since sending required one, the next message opened
   * a directory picker: the menu item took you somewhere you could not do anything. Pointing it at
   * a scratch directory is what makes it a mode instead of a dead end.
   */
  async clearWorkspace() {
    const epoch = get().selectionEpoch + 1;
    set({ selectionEpoch: epoch });
    const scratchCwd = await bridge.git.generalScratch().catch(() => null);
    if (get().selectionEpoch !== epoch) return;
    set({
      scratchCwd,
      workspace: null,
      activeSessionId: null,
      pendingSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      loadingSession: false,
      pendingUserMessage: null,
    });
    useSubAgents.getState().clear();
  },

  /**
   * A project the user described, rather than a directory they pointed at.
   *
   * `pickWorkspace` — the old 「新建项目」 — opened a folder and took its name, so the name and the
   * shape of the project were whatever the filesystem happened to say. This takes both: the first
   * folder is where sessions run (git, the composer's cwd, every path a tool resolves), and the
   * rest are the other parts of the same piece of work.
   */
  async createProject(name: string, folders: string[]) {
    const settings = get().settings;
    const [main, ...rest] = folders.map((folder) => folder.trim()).filter(Boolean);
    if (!settings || !main) return;
    /*
     * Always a new project, with an id of its own.
     *
     * This used to look the main folder up and, finding it, edit that entry — so 「新建项目」 on a
     * folder already in a project renamed the old project and replaced its folders, and the old
     * one was gone. A project is a piece of work; the same checkout can be in two of them.
     */
    const entry = {
      id: crypto.randomUUID(),
      name: name.trim() || baseName(main),
      path: main,
      lastOpenedAt: Date.now(),
      folders: rest.length > 0 ? [main, ...rest] : undefined,
    };
    await get().saveSettings({ ...settings, projects: [entry, ...settings.projects] });
    // Saved first, then opened: `openWorkspace` reads the entry back for the name and the folders.
    await get().openWorkspace(main, entry.id);
  },

  /**
   * 「编辑项目」 — the name and the source folders, which are the two things the dialog shows.
   *
   * The main folder is not editable here and is not meant to be. It is the session's working
   * directory: every stored conversation records it, git reads it, and changing it out from under
   * them is `sessions:move`'s problem rather than a text field's. Extra folders can come and go
   * freely because nothing is anchored to them.
   */
  async updateProject(id: string, patch: { name?: string; folders?: string[] }) {
    const settings = get().settings;
    const path = settings?.projects.find((project) => project.id === id)?.path;
    if (!settings || path === undefined) return;
    const trimmed = patch.name?.trim();
    const rest = (patch.folders ?? []).map((folder) => folder.trim()).filter((folder) => folder && folder !== path);
    await get().saveSettings({
      ...settings,
      projects: settings.projects.map((project) =>
        project.id === id
          ? {
              ...project,
              name: trimmed || project.name,
              // `undefined` rather than `[path]`: a project back down to one folder should look
              // exactly like one that never had a second, on disk and to every reader.
              folders: patch.folders === undefined ? project.folders : rest.length > 0 ? [path, ...rest] : undefined,
            }
          : project,
      ),
    });
    // The header reads the workspace, not the project list, so it needs telling separately.
    const workspace = get().workspace;
    if (trimmed && workspace?.projectId === id) set({ workspace: { ...workspace, name: trimmed } });
  },

  async setSessionPinned(sessionId: string, pinned: boolean) {
    const settings = get().settings;
    if (!settings) return;
    const current = new Set(settings.pinnedSessionIds ?? []);
    if (pinned) {
      current.add(sessionId);
    } else {
      current.delete(sessionId);
    }
    await get().saveSettings({
      ...settings,
      pinnedSessionIds: Array.from(current),
    });
  },

  // 没变就不写：选中会话时都会来问一次，绝大多数会话根本没标过。
  async setSessionUnread(sessionId: string, unread: boolean) {
    const settings = get().settings;
    if (!settings) return;
    const current = new Set(settings.unreadSessionIds ?? []);
    if (current.has(sessionId) === unread) return;
    if (unread) current.add(sessionId);
    else current.delete(sessionId);
    await get().saveSettings({ ...settings, unreadSessionIds: Array.from(current) });
  },
	async reorderProjects(sourceId: string, targetId: string, placement: "before" | "after") {
		const settings = get().settings;
		if (!settings) return false;
		const source = settings.projects.find((project) => project.id === sourceId);
		const target = settings.projects.find((project) => project.id === targetId);
		if (!source || !target) return false;
		const projects = moveBeforeOrAfter(settings.projects, source, target, placement);
		if (!projects) return false;
		await get().saveSettings({ ...settings, projects });
		return true;
	},

	async reorderProjectSessions(projectId: string, sourceId: string, targetId: string, placement: "before" | "after", sort: SessionSortKey) {
		const settings = get().settings;
		if (!settings) return false;
		const pinned = new Set(settings.pinnedSessionIds ?? []);
		const sessions = projectSessions(get().sessions, projectId).filter((session) => !session.archived && !pinned.has(session.id));
		const ordered = orderedSessions(sessions, sort, settings.sessionOrder?.[projectId]).map((session) => session.id);
		const next = moveBeforeOrAfter(ordered, sourceId, targetId, placement);
		if (!next) return false;
		await get().saveSettings({ ...settings, sessionOrder: { ...settings.sessionOrder, [projectId]: next } });
		return true;
	},

  /**
   * Rename a conversation: on screen at once, on disk right after.
   *
   * Painted first because the list should not stutter while a round trip happens, and replaced
   * with what came back because the main process is the authority on the rest of the meta.
   */
  async renameSession(session: SessionMeta, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const previous = session.title;
    set({
      sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)),
      ...(get().activeSessionId === session.id && get().meta ? { meta: { ...get().meta!, title: trimmed } } : {}),
    });
    try {
      const updated = await bridge.sessions.rename(session.id, trimmed);
      if (updated) {
        set({
          sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, ...updated } : s)),
          ...(get().activeSessionId === session.id && get().meta ? { meta: { ...get().meta!, ...updated } } : {}),
        });
      }
    } catch {
      /*
       * Put the old name back and say so.
       *
       * Swallowing this left the new name on screen over a session still called the old thing on
       * disk — the rename looked like it had worked, and the next reload was where you found out.
       * A name that reverts in front of you is not a good outcome either, but it is an honest one.
       */
      set({
        sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, title: previous } : s)),
        ...(get().activeSessionId === session.id && get().meta ? { meta: { ...get().meta!, title: previous } } : {}),
      });
      get().notify(translate("workspace.renameFailed"), "error");
    }
  },

  /**
   * 把一条对话归到另一个项目下——真的归过去，日志文件跟着走。
   *
   * 这里从前只改内存：三个字段在渲染层改掉、弹一句「已移动到 X」，磁盘上一个字节都没动，主进程
   * 那边连「移动会话」这个操作都不存在。于是主进程下一次推送这条会话的任何变化，
   * `applySessionChange` 就拿磁盘上那一份把整条 meta 换回去，界面上它自己飘回原来的项目——用户
   * 报的「过 1 秒就恢复原样」。就算那一秒没人推送，重启一次照样打回原形。
   *
   * 真正的移动只有主进程做得了：会话日志按 `projectId` 分目录存，而 `projectId` 是 cwd 的哈希，
   * 换项目就是换目录，得挪文件。乐观更新仍然留着——点完就该看见它到了新位置——但现在它只是一
   * 张等着兑现的票：兑不了就连同一句说明一起退回去，和 `renameSession` 一个路子。
   */
  async moveSessionProject(session: SessionMeta, target: string) {
    /*
     * By project id, not folder: two projects can share one, and moving between them changes only
     * which project the conversation names — `cwd` stays, nothing on disk moves.
     */
    const targetProject = get().settings?.projects.find((p) => p.id === target);
    /*
     * 「从项目中移除」只是不再属于哪个项目，对话还在它原来的文件夹里跑。
     *
     * 从前要挪进「不在项目中工作」的共享目录：那时侧边栏按 cwd 分组，留在原地就会照着文件夹再长出
     * 一个项目来。现在只认对话记下的项目，原地不动就已经是无项目对话，挪走反倒让它离开了自己的仓库。
     */
    const nextCwd = targetProject?.path ?? session.cwd;
    const nextProjectName = targetProject?.name ?? session.projectName;

    /*
     * 乐观的这一下只动 cwd、projectName 和 project，不动 projectId。
     *
     * 侧边栏分组看的是 project，所以这就够它当场换组；而 projectId 是文件在磁盘上的住址，此刻还没
     * 搬完，渲染层也算不出新值（那是 cwd 的 sha256，在 core 里）。猜一个填进去，万一用户正好在这几
     * 毫秒里点开这条对话，就会拿着一个查无此人的地址去读日志。
     */
    const previous = { cwd: session.cwd, projectName: session.projectName, project: session.project };
    const patch = (fields: Partial<SessionMeta>) =>
      set({
        sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, ...fields } : s)),
        ...(get().activeSessionId === session.id && get().meta ? { meta: { ...get().meta!, ...fields } } : {}),
      });

    patch({ cwd: nextCwd, projectName: nextProjectName, project: targetProject?.id });
    try {
      const result = await bridge.sessions.move(session.id, nextCwd, nextProjectName, targetProject?.id);
      if (!result.ok) {
        patch(previous);
        get().notify(
          result.reason === "running"
            ? translate("workspace.moveWhileRunning")
            : result.reason === "gone"
              ? translate("workspace.moveGone")
              : translate("workspace.moveFailed", { reason: result.message ?? "" }),
          result.reason === "running" ? "warn" : "error",
        );
        return;
      }
      // 主进程说了算的那一份，含着新的 projectId。广播多半已经先到了，这一下是补齐。
      patch(result.meta);
      get().notify(targetProject ? translate("workspace.movedTo", { name: targetProject.name }) : translate("workspace.removedFromProject"));
    } catch (cause) {
      patch(previous);
      get().notify(translate("workspace.moveFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
    }
  },

  async removeProject(id: string) {
    const settings = get().settings;
    if (!settings) return;
    /*
     * The entry goes, and its conversations are archived with it.
     *
     * Dropping the entry alone did not stop the project being listed, which is the one thing this
     * action promises. The sidebar builds a group for any `cwd` it sees among the sessions and
     * falls back to the session's own `projectName` when no configured project matches — so the
     * group was rebuilt on the next render from the very conversations that removing the entry
     * deliberately leaves alone. Delete the folder from disk and it is still there: the sessions
     * live in `~/.plume`, not in the directory they point at. That is the 「删不掉」 report.
     *
     * Archiving rather than deleting keeps the promise on the other half of it. Nothing is lost —
     * the conversations are in 设置 › 已归档 and can be brought back one by one — and it reuses
     * the action the project menu already offers, so "remove" is now "archive its chats, then
     * forget the project" rather than a third kind of disappearance with its own rules.
     */
    /*
     * Archiving is best-effort; forgetting the project is not.
     *
     * Awaiting it bare meant one failing `setArchived` — a session index that cannot be written,
     * a file that went away underneath us — took the removal down with it, and the entry the user
     * asked to delete stayed. That is the same complaint they opened with, arriving through the
     * fix for it. Report the failure and carry on: a project still listed after a successful
     * archive is the bug; a project removed while some chats keep their place in 「最近」 is
     * recoverable, and visible.
     */
    try {
      await get().archiveProjectSessions(id);
    } catch (error) {
      get().notify(translate("workspace.archiveFailed", { reason: String(error) }), "error");
    }
    const latest = get().settings ?? settings;
    await get().saveSettings({
      ...latest,
      projects: latest.projects.filter((p) => p.id !== id),
    });
    if (get().workspace?.projectId === id) void get().clearWorkspace();
  },

  async archiveProjectSessions(id: string) {
    // The conversations that record this project, wherever they run; another project on the same folder keeps its own.
    const filed = new Set(projectSessions(get().sessions, id).map((s) => s.id));
    const targets = get().sessions.filter((s) => filed.has(s.id) && !s.archived);
    if (targets.length === 0) return;
    set({
      sessions: get().sessions.map((s) =>
        filed.has(s.id) && !s.archived ? { ...s, archived: true } : s,
      ),
    });
    if (targets.some((s) => s.id === get().activeSessionId)) {
      set({
        activeSessionId: null,
        pendingSessionId: null,
        meta: null,
        messages: [],
        toolRuns: {},
        approvals: [],
        loadingSession: false,
        pendingUserMessage: null,
      });
      useSubAgents.getState().clear();
    }
    // Sequential rather than parallel: each call rewrites the shared session index.
    let latest = get().sessions;
    for (const session of targets) {
      latest = await bridge.sessions.setArchived(session.id, true);
    }
    set({ sessions: latest });
    get().notify(translate("workspace.archived", { n: targets.length }));
  },
  };
}
