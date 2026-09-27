/**
 * Every method the renderer may call.
 *
 * This list is the answer to a question that used to be answered in two places:
 *
 *   which channel does this method use      → `preload.ts`, one `invoke` per method
 *   what does it look like                  → `ipc-types.ts`, a hand-written interface
 *
 * `test/methods.test.ts` compares it with `preload.ts` and every `ipcMain.handle` in the main
 * process on every run, so none of them can drift apart again. The main process was the last one
 * added and the one that mattered most: it is the end that actually answers, and it was the end
 * nothing looked at.
 */

export interface Method {
	/** The IPC channel. It appears here and nowhere else, so it cannot be misspelt at a call site. */
	channel: string;
}

/**
 * The methods, by group.
 *
 * Grouped the way `window.lyra` is grouped, so a reader can hold one subject at a time. Within a
 * group the order is the order they appear in the preload, which is roughly the order they were
 * written.
 */
export const METHODS = {
	agentDefinitions: {
		list: { channel: "agentdefs:list" },
		read: { channel: "agentdefs:read" },
		save: { channel: "agentdefs:save" },
		remove: { channel: "agentdefs:remove" },
		restore: { channel: "agentdefs:restore" },
	},
	delivery: {
		get: { channel: "delivery:get" },
		undo: { channel: "delivery:undo" },
	},
	services: {
		list: { channel: "services:list" },
		stop: { channel: "services:stop" },
	},
	browser: {
		state: { channel: "browser:state" },
		command: { channel: "browser:command" },
		attach: { channel: "browser:attach" },
		inspect: { channel: "browser:inspect" },
		cancelInspect: { channel: "browser:cancelInspect" },
	},
	settings: {
		get: { channel: "settings:get" },
		save: { channel: "settings:save" },
		layers: { channel: "settings:layers" },
	},
	web: {
		status: { channel: "web:status" },
		start: { channel: "web:start" },
		stop: { channel: "web:stop" },
		rotateToken: { channel: "web:rotateToken" },
	},
	usage: {
		scan: { channel: "usage:scan" },
		storage: { channel: "usage:storage" },
		clear: { channel: "usage:clear" },
	},
	workspace: {
		pick: { channel: "workspace:pick" },
		foreignConfigs: { channel: "workspace:foreignConfigs" },
		markForeignConfigsSeen: { channel: "workspace:markForeignConfigsSeen" },
		info: { channel: "workspace:info" },
		reveal: { channel: "workspace:reveal" },
	},
	sessions: {
		list: { channel: "sessions:list" },
		/* 这个会话此刻在不在跑——权威的那一份，用来和渲染层自己推出来的那份对账。 */
		running: { channel: "sessions:running" },
		create: { channel: "sessions:create" },
		open: { channel: "sessions:open" },
		transcript: { channel: "sessions:transcript" },
		trajectory: { channel: "sessions:trajectory" },
		trajectoryChanges: { channel: "sessions:trajectoryChanges" },
		exportTrajectory: { channel: "sessions:exportTrajectory" },
		fork: { channel: "sessions:fork" },
		remove: { channel: "sessions:remove" },
		setArchived: { channel: "sessions:setArchived" },
		move: { channel: "sessions:move" },
		removeArchived: { channel: "sessions:removeArchived" },
		capabilities: { channel: "sessions:capabilities" },
		rename: { channel: "sessions:rename" },
		compact: { channel: "sessions:compact" },
		contextBreakdown: { channel: "sessions:contextBreakdown" },
	},
	agent: {
		prompt: { channel: "agent:prompt" },
		editMessage: { channel: "agent:editMessage" },
		revertMessage: { channel: "agent:revertMessage" },
		abort: { channel: "agent:abort" },
		approve: { channel: "agent:approve" },
		setModel: { channel: "agent:setModel" },
		setThinking: { channel: "agent:setThinking" },
	},
	subAgents: {
		list: { channel: "subagents:list" },
		detail: { channel: "subagents:detail" },
		steer: { channel: "subagents:steer" },
		abort: { channel: "subagents:abort" },
		dismiss: { channel: "subagents:dismiss" },
		dismissFinished: { channel: "subagents:dismissFinished" },
	},
	sideChat: {
		setModel: { channel: "sidechat:setModel" },
		state: { channel: "sidechat:state" },
		ask: { channel: "sidechat:ask" },
		editAndResend: { channel: "sidechat:editAndResend" },
		abort: { channel: "sidechat:abort" },
		reset: { channel: "sidechat:reset" },
	},
	tasks: {
		list: { channel: "tasks:list" },
		cancel: { channel: "tasks:cancel" },
		dismiss: { channel: "tasks:dismiss" },
		resume: { channel: "tasks:resume" },
	},
	files: {
		list: { channel: "files:list" },
		read: { channel: "files:read" },
		document: { channel: "files:document" },
		documentText: { channel: "files:documentText" },
		bytes: { channel: "files:bytes" },
		create: { channel: "files:create" },
		rename: { channel: "files:rename" },
		copy: { channel: "files:copy" },
		trash: { channel: "files:trash" },
		remove: { channel: "files:remove" },
		uniquePath: { channel: "files:uniquePath" },
		exists: { channel: "files:exists" },
		importInto: { channel: "files:import" },
		pick: { channel: "files:pick" },
	},
	clipboard: {
		read: { channel: "clipboard:read" },
		write: { channel: "clipboard:write" },
		writeImage: { channel: "clipboard:writeImage" },
	},
	terminal: {
		list: { channel: "terminal:list" },
		listAll: { channel: "terminal:list-all" },
		open: { channel: "terminal:open" },
		attach: { channel: "terminal:attach" },
	},
	providers: {
		test: { channel: "providers:test" },
		fetchModels: { channel: "providers:fetchModels" },
	},
	commands: {
		list: { channel: "commands:list" },
		create: { channel: "commands:create" },
		reveal: { channel: "commands:reveal" },
		open: { channel: "commands:open" },
	},
	plugins: {
		list: { channel: "plugins:list" },
		revealDir: { channel: "plugins:revealDir" },
		fetchRegistry: { channel: "registry:fetch" },
		icon: { channel: "registry:icon" },
		icons: { channel: "registry:icons" },
		installFromRegistry: { channel: "registry:install" },
		uninstall: { channel: "registry:uninstall" },
	},
	updates: {
		check: { channel: "updates:check" },
		state: { channel: "updates:state" },
		download: { channel: "updates:download" },
		pause: { channel: "updates:pause" },
		cancel: { channel: "updates:cancel" },
		relaunch: { channel: "updates:relaunch" },
		reopen: { channel: "updates:reopen" },
		open: { channel: "updates:open" },
	},
	windows: {
		keepOnTop: { channel: "windows:keepOnTop" },
		open: { channel: "windows:open" },
		list: { channel: "windows:list" },
		openInMain: { channel: "windows:openInMain" },
		openPanel: { channel: "windows:openPanel" },
		openPanelInMain: { channel: "windows:openPanelInMain" },
		filePanelState: { channel: "windows:filePanelState" },
		restorePanel: { channel: "windows:restorePanel" },
		closePanel: { channel: "windows:closePanel" },
	},
	system: {
		openPath: { channel: "system:openPath" },
		openExternal: { channel: "system:openExternal" },
		openIn: { channel: "system:openIn" },
		openTargets: { channel: "system:openTargets" },
		revealSkillsDir: { channel: "system:revealSkillsDir" },
		platform: { channel: "system:platform" },
		remoteImage: { channel: "system:remoteImage" },
		pathExists: { channel: "system:pathExists" },
	},
	screenshot: {
		start: { channel: "screenshot:start" },
		finish: { channel: "screenshot:finish" },
		cancel: { channel: "screenshot:cancel" },
		download: { channel: "screenshot:download" },
		pin: { channel: "screenshot:pin" },
		pinnedCount: { channel: "screenshot:pinnedCount" },
		pickDirectory: { channel: "screenshot:pickDirectory" },
	},
	/*
	 * 置顶在桌面的那张图片，自己的窗口在问自己的事。
	 *
	 * 单独一组而不是挂在 screenshot 下面：用到它的时候截图早就结束了，剩下的只是一个显示图片的
	 * 小窗口。它拉取而不是被推送——组件是按需加载的，窗口 did-finish-load 时监听还没注册，推过去
	 * 的消息会无声地掉在地上，窗口就空着。
	 */
	pinnedShot: {
		request: { channel: "pin:request" },
	},
	index: {
		stats: { channel: "index:stats" },
		rebuild: { channel: "index:rebuild" },
		search: { channel: "index:search" },
	},
	scheduler: {
		runNow: { channel: "scheduler:runNow" },
	},
	/* 回答「要把这次纠正变成一条规则吗」那张卡片。 */
	extensions: {
		stats: { channel: "extensions:stats" },
	},
	capabilities: {
		trash: { channel: "capabilities:trash" },
		diff: { channel: "capabilities:diff" },
		prefer: { channel: "capabilities:prefer" },
	},
	rules: {
		preview: { channel: "rules:preview" },
		keep: { channel: "rules:keep" },
		decline: { channel: "rules:decline" },
		list: { channel: "rules:list" },
		/* 从会话里总结出来的技能候选。 */
		pendingSkills: { channel: "skills:pending" },
		approveSkill: { channel: "skills:approve" },
		rejectSkill: { channel: "skills:reject" },
		setDisabled: { channel: "rules:setDisabled" },
		setForeignUser: { channel: "rules:setForeignUser" },
	},
	forge: {
		kinds: { channel: "forge:kinds" },
		accounts: { channel: "forge:accounts" },
		signIn: { channel: "forge:signIn" },
		signOut: { channel: "forge:signOut" },
		setEnabled: { channel: "forge:setEnabled" },
		rename: { channel: "forge:rename" },
	},
	git: {
		myPullRequests: { channel: "git:myPullRequests" },
		pullRequest: { channel: "git:pullRequest" },
		pullRequestDiff: { channel: "git:pullRequestDiff" },
		scratchForPullRequest: { channel: "scratch:forPullRequest" },
		generalScratch: { channel: "scratch:general" },
		scratchRoots: { channel: "scratch:roots" },
		findLocalCheckout: { channel: "git:findLocalCheckout" },
		avatar: { channel: "git:avatar" },
		avatars: { channel: "git:avatars" },
		commentOnPullRequest: { channel: "git:commentOnPullRequest" },
		reviewPullRequest: { channel: "git:reviewPullRequest" },
		branches: { channel: "git:branches" },
		switchBranch: { channel: "git:switchBranch" },
		createWorktree: { channel: "git:createWorktree" },
		removeWorktree: { channel: "git:removeWorktree" },
		pruneWorktrees: { channel: "git:pruneWorktrees" },
		stat: { channel: "git:stat" },
		commit: { channel: "git:commit" },
		status: { channel: "git:status" },
		repos: { channel: "git:repos" },
		worktrees: { channel: "git:worktrees" },
		init: { channel: "git:init" },
		log: { channel: "git:log" },
		commitDiff: { channel: "git:commitDiff" },
		commitDiffSummary: { channel: "git:commitDiffSummary" },
		diffRefs: { channel: "git:diffRefs" },
		stage: { channel: "git:stage" },
		unstage: { channel: "git:unstage" },
		discard: { channel: "git:discard" },
		commitStaged: { channel: "git:commitStaged" },
		generateCommitMessage: { channel: "git:generateCommitMessage" },
		createBranch: { channel: "git:createBranch" },
		deleteBranch: { channel: "git:deleteBranch" },
		push: { channel: "git:push" },
		pull: { channel: "git:pull" },
		fetch: { channel: "git:fetch" },
		cancelRemote: { channel: "git:cancelRemote" },
		releaseInfo: { channel: "git:releaseInfo" },
		bumpVersion: { channel: "git:bumpVersion" },
		triggerDryRun: { channel: "git:triggerDryRun" },
		listWorkflowRuns: { channel: "git:listWorkflowRuns" },
		workflowRunStatus: { channel: "git:workflowRunStatus" },
		publishReleaseTag: { channel: "git:publishReleaseTag" },
	},
	memory: {
		load: { channel: "memory:load" },
		add: { channel: "memory:add" },
		remove: { channel: "memory:remove" },
		clear: { channel: "memory:clear" },
	},
	/*
	 * 分组叫 `projectMemory`，channel 却在 `memory:` 域下。
	 *
	 * 不是不一致。channel 的形状是 `域:动作`，而域必须是一个小写词——`methods.test.ts` 在管这件
	 * 事，它的注释写得很好：「已知的一处例外」和「随便怎么写都行」是两回事。而项目记忆和用户
	 * 偏好记忆读写的是不同的地方、有各自的开关，在 `window.lyra` 上分开才说得清。
	 *
	 * 于是域共用、动作带前缀。这条测试是在 `git push` 的钩子里抓到我的——它值这个位置。
	 */
	projectMemory: {
		status: { channel: "memory:projectStatus" },
		extract: { channel: "memory:projectExtract" },
		list: { channel: "memory:projectList" },
		forget: { channel: "memory:projectForget" },
		forgetExtracted: { channel: "memory:projectForgetExtracted" },
		forgetAll: { channel: "memory:projectForgetAll" },
	},
	diff: {
		workspaceDiff: { channel: "diff:workspace" },
		blob: { channel: "diff:blob" },
	},
} as const satisfies Record<string, Record<string, Method>>;

/** Every channel name, flat. For the main process, which registers by channel. */
export const CHANNELS: readonly string[] = Object.values(METHODS).flatMap((group) =>
	Object.values(group).map((method) => method.channel),
);
