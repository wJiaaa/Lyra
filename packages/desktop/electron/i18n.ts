import type { UiLocale } from "@plume/core";

export type NativeLocale = Exclude<UiLocale, "system">;

const zhCN = {
	"tray.show": "打开 Plume",
	"tray.hide": "隐藏 Plume",
	"tray.newChat": "新对话",
	"tray.recent": "最近会话",
	"tray.noChats": "还没有会话",
	"tray.pullRequests": "拉取请求",
	"tray.scheduled": "定时任务",
	"tray.settings": "设置…",
	"tray.launchAtLogin": "开机时启动",
	"tray.quit": "退出 Plume",
	"dialog.projectDirectory": "选择项目目录",
	"dialog.screenshotDirectory": "选择截图保存位置",
	"shortcut.taken": "截图全局快捷键 {shortcut} 没能注册，可能已被其他应用占用（比如微信的截图键）。可以在 设置 → 屏幕截图 里换一个。",
	"shortcut.invalid": "截图全局快捷键 {shortcut} 无法识别，没有注册。可以在 设置 → 屏幕截图 里重新录一个。",
	"terminal.unavailable": "终端无法启动：原生组件 node-pty 没能加载。Plume 的其他功能不受影响。",
	"terminal.tab": "终端 {n}",
	// The session database would not open at startup; `reason` is what SQLite or the version check said.
	"sessions.unavailableTitle": "Plume 打不开会话记录",
	"sessions.unavailable": "会话库 {path} 打不开：{reason}\n\nPlume 没有动这个文件。它可能正被另一个 Plume 占用，或者是更新版本的 Plume 写的。先退出其他 Plume 再打开；仍然打不开，就把 sessions.db 连同旁边同名的 -wal、-shm 文件一起挪到别处，Plume 会新建一个。",
	// System notifications. `detail` joins a status line to what the agent asked, so each language
	// brings its own separator and quote marks instead of inheriting 「」 and ：.
	"notification.done": "「{title}」已完成",
	"notification.doneUntitled": "任务已完成",
	"notification.approval": "「{title}」等待批准",
	"notification.approvalUntitled": "等待批准",
	"notification.reply": "「{title}」等待回复",
	"notification.replyUntitled": "等待回复",
	"notification.detail": "{status}：{detail}",
	// A background sub-agent's question, after the name of the agent asking it.
	"notification.asking": "{agent}：{question}",
	// Scheduled tasks: the notice the window shows when one starts, or fails to.
	"scheduled.started": "定时任务「{name}」开始运行",
	"scheduled.failed": "定时任务「{name}」失败：{reason}",
	"scheduled.couldNotStart": "定时任务「{name}」无法启动：{reason}",
	// File operations: why the file tree could not do what it was asked to.
	"files.outsideProject": "该路径不在已打开的项目内",
	"files.exists": "「{name}」已存在",
	"files.moveIntoItself": "不能把文件夹移动到它自己里面",
	"files.copyIntoItself": "不能把文件夹复制到它自己里面",
	"files.deleteFailed": "「{name}」删除失败：{reason}",
	"files.nameEmpty": "名字不能为空",
	"files.nameSpaceAround": "名字前后不能有空格",
	"files.nameDots": "不能用 . 或 .. 作为名字",
	"files.nameNul": "名字里有不允许的字符",
	"files.nameSlash": "名字里不能有 /",
	"files.nameBackslash": "名字里不能有 \\",
	"files.nameTooLong": "名字太长",
	"files.nameWindowsChars": '名字里不能有 " * : < > ? |',
	"files.nameTrailingDot": "名字不能以点结尾",
	"files.nameReserved": "{name} 是系统保留名",
	// Code hosting: why pull requests, or signing in to the account that lists them, failed.
	// `withDetail` appends what the host itself said, with each language's own separator.
	"forge.githubTokenInvalid": "GitHub 令牌无效或已过期，去设置里重新填一个",
	"forge.gitlabTokenInvalid": "GitLab 令牌无效或已过期，去设置里重新填一个",
	"forge.giteeTokenInvalid": "Gitee 私人令牌无效或已过期，去设置里重新填一个",
	"forge.giteaTokenInvalid": "Gitea 令牌无效或已过期，去设置里重新填一个",
	"forge.rateLimited": "被限流了，过一会儿会自动恢复",
	"forge.forbidden": "没有权限做这件事",
	"forge.forbiddenScope": "没有权限做这件事，检查令牌的 scope",
	"forge.notFound": "找不到这个仓库或 PR，可能是没有访问权限，也可能是令牌 scope 不够",
	"forge.rejected": "对方拒绝了这次提交",
	"forge.serverError": "对方服务出错了（{status}）",
	"forge.requestFailed": "请求失败（{status}）",
	"forge.withDetail": "{message}：{detail}",
	"forge.timeout": "连接 {host} 超时",
	"forge.unresolved": "解析不到 {host}，检查地址或网络",
	"forge.refused": "{host} 拒绝连接，服务可能没在跑",
	"forge.certificate": "{host} 的证书没通过校验",
	"forge.unreachable": "连不上 {host}",
	"forge.theServer": "服务器",
	"forge.unknownError": "出错了",
	"forge.notJson": "接口返回的不是 JSON，检查一下服务地址填对了没有",
	"forge.accountGone": "这个账号已经不在了，去设置里重新添加",
	"forge.tokenUnreadable": "{account} 的令牌读不出来了，去设置里重新填一次",
	"forge.noAccounts": "还没有添加代码托管账号",
	"forge.allAccountsFailed": "所有账号都没能读到 Pull Request",
	"forge.emptyComment": "评论不能为空",
	"forge.changesNeedReason": "请求修改需要说明理由",
	"forge.badServer": "服务地址填得不对，应该像 https://gitlab.com",
	"forge.noToken": "把令牌粘贴进来",
	"forge.badRepoName": "仓库名 {repo} 不是 owner/name 的形式",
	"forge.noUserInfo": "令牌有效，但读不到用户信息",
	"forge.githubRateLimited": "GitHub 暂时限流了，过一会儿会自动恢复",
	"forge.githubRejected": "GitHub 拒绝了这次查询",
	"forge.githubNoData": "GitHub 没有返回数据",
	"forge.pullRequestMissing": "{repo} 里没有 #{number}",
	"forge.noMergeRequests": "读不到合并请求",
} as const;

export type NativeMessageKey = keyof typeof zhCN;
type NativeCatalog = Record<NativeMessageKey, string>;
/** Values for a message's `{name}` slots. */
type NativeMessageVariables = Readonly<Record<string, string | number>>;

/** Exported so tests can hold both languages to the same keys and slots. */
export const NATIVE_CATALOGS: Record<NativeLocale, NativeCatalog> = {
	"zh-CN": zhCN,
	en: {
		"tray.show": "Open Plume", "tray.hide": "Hide Plume", "tray.newChat": "New chat", "tray.recent": "Recent chats", "tray.noChats": "No chats yet", "tray.pullRequests": "Pull requests", "tray.scheduled": "Scheduled", "tray.settings": "Settings…", "tray.launchAtLogin": "Launch at login", "tray.quit": "Quit Plume", "dialog.projectDirectory": "Choose project folder", "dialog.screenshotDirectory": "Choose screenshot folder",
		"shortcut.taken": "The global shortcut {shortcut} could not be registered — another app is probably using it (WeChat's screenshot key, for one). Pick another in Settings → Screenshots.",
		"shortcut.invalid": "The global shortcut {shortcut} is not a key combination this system recognises, so it was not registered. Record it again in Settings → Screenshots.",
		"terminal.unavailable": "The terminal cannot start: its native component, node-pty, failed to load. The rest of Plume is unaffected.",
		"terminal.tab": "Terminal {n}",
		"sessions.unavailableTitle": "Plume can't open your conversations",
		"sessions.unavailable": "The session database at {path} would not open: {reason}\n\nPlume has left the file as it is. Another copy of Plume may have it open, or a newer version of Plume may have written it. Quit any other copy and try again. If it still won't open, move sessions.db somewhere else together with the -wal and -shm files beside it, and Plume will start a new one.",
		"notification.done": "“{title}” finished", "notification.doneUntitled": "Task finished",
		"notification.approval": "“{title}” needs your approval", "notification.approvalUntitled": "Waiting for your approval",
		"notification.reply": "“{title}” needs your input", "notification.replyUntitled": "Waiting for your input",
		"notification.detail": "{status}: {detail}",
		"notification.asking": "{agent}: {question}",
		"scheduled.started": "Scheduled task “{name}” started",
		"scheduled.failed": "Scheduled task “{name}” failed: {reason}",
		"scheduled.couldNotStart": "Scheduled task “{name}” could not start: {reason}",
		"files.outsideProject": "That path is not inside an open project",
		"files.exists": "“{name}” already exists",
		"files.moveIntoItself": "A folder cannot be moved into itself",
		"files.copyIntoItself": "A folder cannot be copied into itself",
		"files.deleteFailed": "Could not delete “{name}”: {reason}",
		"files.nameEmpty": "A name cannot be empty",
		"files.nameSpaceAround": "A name cannot start or end with a space",
		"files.nameDots": ". and .. cannot be used as names",
		"files.nameNul": "The name contains a character that is not allowed",
		"files.nameSlash": "A name cannot contain /",
		"files.nameBackslash": "A name cannot contain \\",
		"files.nameTooLong": "The name is too long",
		"files.nameWindowsChars": 'A name cannot contain " * : < > ? |',
		"files.nameTrailingDot": "A name cannot end with a dot",
		"files.nameReserved": "{name} is a reserved system name",
		"forge.githubTokenInvalid": "The GitHub token is invalid or has expired — enter a new one in Settings",
		"forge.gitlabTokenInvalid": "The GitLab token is invalid or has expired — enter a new one in Settings",
		"forge.giteeTokenInvalid": "The Gitee personal access token is invalid or has expired — enter a new one in Settings",
		"forge.giteaTokenInvalid": "The Gitea token is invalid or has expired — enter a new one in Settings",
		"forge.rateLimited": "Rate limited — this clears by itself in a little while",
		"forge.forbidden": "No permission to do this",
		"forge.forbiddenScope": "No permission to do this — check the token's scopes",
		"forge.notFound": "This repository or PR could not be found — there may be no access to it, or the token's scopes may not cover it",
		"forge.rejected": "The host rejected this change",
		"forge.serverError": "The host's service ran into an error ({status})",
		"forge.requestFailed": "The request failed ({status})",
		"forge.withDetail": "{message}: {detail}",
		"forge.timeout": "Connecting to {host} timed out",
		"forge.unresolved": "Could not resolve {host} — check the address or the network",
		"forge.refused": "The connection was refused by {host} — the service may not be running",
		"forge.certificate": "The certificate from {host} did not pass verification",
		"forge.unreachable": "Could not reach {host}",
		"forge.theServer": "the server",
		"forge.unknownError": "Something went wrong",
		"forge.notJson": "The API did not answer in JSON — check that the server address is right",
		"forge.accountGone": "This account no longer exists — add it again in Settings",
		"forge.tokenUnreadable": "The token for {account} can no longer be read — enter it again in Settings",
		"forge.noAccounts": "No code hosting accounts have been added yet",
		"forge.allAccountsFailed": "None of the accounts could load pull requests",
		"forge.emptyComment": "A comment cannot be empty",
		"forge.changesNeedReason": "Requesting changes needs a reason",
		"forge.badServer": "That server address is not right — it should look like https://gitlab.com",
		"forge.noToken": "Paste the token in",
		"forge.badRepoName": "The repository name {repo} is not in owner/name form",
		"forge.noUserInfo": "The token works, but the user's details could not be read",
		"forge.githubRateLimited": "GitHub is rate limiting for now — this clears by itself in a little while",
		"forge.githubRejected": "GitHub rejected this query",
		"forge.githubNoData": "GitHub returned no data",
		"forge.pullRequestMissing": "{repo} has no #{number}",
		"forge.noMergeRequests": "Could not load merge requests",
	},
};

export function resolveNativeLocale(locale: UiLocale, systemLocale: string): NativeLocale {
	if (locale !== "system") return locale;
	const normalized = systemLocale.trim().replaceAll("_", "-").toLowerCase();
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
	return "en";
}

export function nativeTranslator(
	locale: UiLocale,
	systemLocale: string,
): (key: NativeMessageKey, variables?: NativeMessageVariables) => string {
	const catalog = NATIVE_CATALOGS[resolveNativeLocale(locale, systemLocale)];
	return (key, variables) => {
		const template = catalog[key];
		if (!variables) return template;
		// A replacer function, so `$&` in a session title stays text instead of becoming a pattern.
		return template.replace(/\{([^}]+)\}/g, (slot, name: string) => {
			const value = variables[name];
			return value === undefined ? slot : String(value);
		});
	};
}

/**
 * Which language main-process text is written in, asked each time some is written.
 *
 * `main.ts` points this at the interface language setting once, at startup, so modules with no
 * settings of their own (the scheduler, the code-host client, the update download) can write in it
 * and a language change reaches the very next message. Until it is set — only in tests — it is the
 * catalog's source language.
 */
let interfaceLocale: () => NativeLocale = () => "zh-CN";

export function setInterfaceLocaleSource(read: () => NativeLocale): void {
	interfaceLocale = read;
}

/**
 * A message in the interface language as it is set right now. For text a person reads — a notice,
 * or an error a panel shows; log lines stay as they are.
 */
export function nativeText(key: NativeMessageKey, variables?: NativeMessageVariables): string {
	// The locale is already resolved, so the system locale beside it is never consulted.
	return nativeTranslator(interfaceLocale(), "en")(key, variables);
}
