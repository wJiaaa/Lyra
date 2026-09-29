# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.9.22](https://github.com/wJiaaa/Plume/releases/tag/v0.9.22) - 2026-09-29
<!-- plume:notes en -->

### Lyra is now Plume

- **New name, new data folder, nothing carried over.** Settings, chats and keys live in `~/.plume` instead of `~/.lyra`. In a project, Plume reads `PLUME.md` (then `AGENTS.md`, then `CLAUDE.md`) and keeps its files in `.plume/`; environment variables start with `PLUME_`. The old names are not read at all, so add your providers again after installing, and rename `LYRA.md` and `.lyra/` in projects you want to keep using them in.
- **Updates are downloaded by hand.** The in-app updater, the About page and "Check for updates…" in the tray are gone. New versions are published on this Releases page.

### New

- **More than one side chat per conversation.** Each side chat has its own tab and closes on its own. The side chat button in the conversation title bar opens a new one every time you press it.
- **Panels as tabs.** Appearance › Panels › Tabs, now the default, puts files, terminal, browser and side chats in a single pane on the right, one tab each. Switching tabs does not restart the terminal or reload the page in the browser. Split keeps the previous arrangement, and switching back puts every panel where it was.
- **A turn can fold into one line.** Appearance › Tool calls › Collapsed shows the whole turn under one line, with one row per call. What the model says between calls now stays outside the folded part, so collapsing a turn no longer hides it.
- **Web access.** Open Plume from a browser on the same local network: the same conversations, replies as they stream, and you can send, stop and approve from there. The terminal, writing files and changing settings stay on the desktop.
- **Skills can be switched off one at a time.** Skills are grouped by the folder they come from (such as `~/.agents/skills`), and a skill that came with a plugin names that plugin. A switched-off skill disappears from the `/` menu and from new conversations.
- **Hooks use the Claude Code format**: a `hooks.json` grouped by event, with SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure and Stop. Hooks that come with a project do not run until you trust them, and changing one asks again.
- **The MCP tab shows whether each server connects, and its tools, without an open conversation.** Before, it could only say "Enabled".
- **Fill in from the model catalogue.** The model editor can copy context window, output limit, capabilities and price from the pi.dev catalogue once. Everything stays editable afterwards, and the model ID is never changed. The catalogue refreshes every hour.
- **Usage › Cache misses** lists requests that should have reused the prompt cache and did not, with the first thing that changed: tools, system prompt, rewritten history or provider.
- Settings for plugins, subagents, hooks and commands have a project picker. They start at user level instead of silently following whichever conversation is open.
- Folders can be dragged into the message box. Anything dropped from Finder or the file tree becomes an `@` reference.
- A conversation can be marked as unread from its menu. The translucent sidebar on macOS can be turned off in Appearance.

### Fixes

- **Edits could land on an out-of-date copy of a file.** Editing or writing a file now requires the version the model last read. A line-number edit touching several places could swallow the lines between them; all changes are now applied to the original file in one pass, and overlapping ranges are refused. Windows line endings and the final newline are kept.
- **Reading a long file could throw away code read earlier.** A plain read of a long source file returns an outline, and that outline was taken as a full read, so function bodies the model had already read were dropped from context. Outlines, truncated reads and failed reads no longer replace anything.
- **After one retry mid-reply, the context was counted twice.** About 10k tokens was reported as 20k, which started compaction on small context windows for no reason.
- **Tool results and summaries could overflow the context window together.** Each result was measured on its own, so ten results of 8,000 characters passed untouched and a summary request reached 18k tokens on a 10k window. They are now measured as a whole.
- **A reply that stops at the output limit carries on by itself.** A tool call whose arguments were cut off is not run; the model is told to split it up.
- **When the model looked up earlier messages, a long message came back as its start and end, not the part that matched.** It now gets the text around each match.
- **Checking ten different images in a row ended the turn.** The model now gets a reminder at the fifth; only the same call with the same arguments and result, repeated ten times, stops it.
- **Commands treated as read-only could run or write through their options**, such as `fd -x`, `rg --pre`, `git branch -D` and `git remote set-url`. Those no longer skip approval.
- **MCP tools that declare themselves read-only run in parallel and no longer ask for approval** in the default permission mode.
- Images returned by a tool are sent to models that can read images, over both OpenAI protocols.
- Anthropic replies no longer lose text or thinking that arrives with the start of a block. A model's refusal is shown as a refusal rather than an empty reply, and is not retried. Rate-limit waits follow `Retry-After`, "try again in" and `x-ratelimit-reset-*`, up to 60 seconds.
- In the dark theme the faintest text goes from 30% to 50% (contrast about 2.2:1 to 3.9:1), so thinking and tool rows are readable. A colour typed without `#`, such as `1A1C1F`, no longer makes the swatch transparent.

### Removed

- Rules: the Rules tab, the rule tool, the suggestion to save a correction as a rule, and rules read from Cursor, Windsurf, Cline, Copilot and Codex.
- The mobile app and Settings › Mobile sync.
- Interface languages other than English and Simplified Chinese. Chinese regions use Simplified Chinese.
- Code formatting. The file panel is a read-only preview, without editing or saving.
- Custom request headers for providers. OpenCode Go gets its session header automatically.
- Pinned projects (conversations can still be pinned), the Tools page in Settings, and the settings for when to send work to subagents: the model decides, with up to 4 at a time and 2 levels deep.
- Font weight settings for the interface and for code, conversation width, default message box height, and the bundled fonts; system fonts are used.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### Lyra 改名为 Plume

- **名字、数据目录都换了，旧数据不会带过来。** 设置、会话和密钥现在放在 `~/.plume`，不再是 `~/.lyra`。在项目里，Plume 读 `PLUME.md`（其次 `AGENTS.md`、`CLAUDE.md`），自己的文件放在 `.plume/`；环境变量改为 `PLUME_` 开头。旧名字一概不再读取：装好后要重新添加服务商；项目里的 `LYRA.md` 和 `.lyra/` 想继续用，就改成新名字。
- **更新要自己下载。** 应用内更新、关于页和托盘里的「检查更新…」都去掉了，新版本发在这个 Releases 页面上。

### 新功能

- **一个会话可以开多个侧边聊天。** 每个侧边聊天占一个标签，可以单独关掉。会话标题栏上的侧边聊天按钮，每点一次就新开一个。
- **面板可以收成标签页。** 「外观 › 面板 › 标签页」现在是默认值：文件、终端、浏览器和侧边聊天都收在右侧同一个面板里，每个占一个标签。切换标签不会重启终端，也不会让浏览器重新加载。选「分栏」是原来的排法，切回去时各个面板回到原位。
- **一轮可以收成一行。** 「外观 › 调用链 › 折叠」把整轮收在一行下面，每次调用各占一行。模型在两次调用之间说的话现在留在折叠区外面，收起一轮不会把它藏掉。
- **Web 访问。** 在同一局域网的浏览器里打开这台电脑上的 Plume：看到的是同样的会话，回复实时出现，也能发消息、停止和审批。终端、写文件、修改设置只在桌面端可用。
- **技能可以一个个关掉。** 技能按所在目录分组（比如 `~/.agents/skills`），插件带来的技能会写明是哪个插件。关掉的技能不会出现在 `/` 菜单里，新会话也不会用到它。
- **钩子改用 Claude Code 的格式**：`hooks.json` 按事件分组，支持 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop 七个事件。项目里带的钩子要你信任之后才会运行，改过之后会再问一次。
- **不开会话，MCP 标签里也能看到每个服务连没连上、有哪些工具。** 以前只能显示「已启用」。
- **从模型目录填入。** 模型编辑器可以从 pi.dev 的模型目录把上下文、输出上限、能力和价格填进来，只填这一次，之后随便改，模型 ID 不会被动。目录每小时同步一次。
- **「使用统计 › 缓存未命中」** 列出本该用上提示缓存却没用上的请求，并指出最先变化的是哪一处：工具、系统提示词、改写过的历史，还是服务商。
- 设置里的插件、智能体、钩子、命令页多了项目选择器，默认是用户级，不再暗中跟着当前打开的会话走。
- 输入框可以拖入文件夹。从访达或文件树拖进来的东西，都会写成 `@` 引用。
- 会话菜单里可以「标记为未读」。macOS 上的毛玻璃侧边栏可以在「外观」里关掉。

### 修复

- **编辑可能改在文件的旧版本上。** 现在编辑或写入文件之前，必须对得上模型最后读到的那一版。按行号编辑一次改多处时，可能把中间的行吞掉；现在所有修改都基于原文件一次完成，区间重叠的直接拒绝。Windows 换行符和文件末尾的换行都会保留。
- **读长文件可能把之前读过的代码挤掉。** 直接读一个很长的源文件，拿到的是大纲，而这份大纲被当成读了全文，模型读过的函数正文就被从上下文里清掉了。现在大纲、被截断的读取和失败的读取都不会顶替已读的内容。
- **回复中途重试一次，上下文就按两倍算。** 大约 10k 的上下文被算成 20k，小窗口的模型会无故开始压缩。
- **工具结果和摘要加在一起可能超出上下文窗口。** 以前每条结果单独衡量，十条 8000 字符的结果原样放行，10k 的窗口上摘要请求到了 18k tokens。现在按总量衡量。
- **回复停在输出上限时会自己接着写。** 参数被截断的工具调用不会执行，模型会被提示把它拆小。
- **模型回查之前的消息时，长消息只拿到开头和结尾，拿不到命中的那一段。** 现在给的是每个命中词附近的原文。
- **连续检查十张不同的图，这一轮就被掐断。** 现在第 5 次时提醒一次；只有同一个调用、同样的参数和结果重复 10 次才会停下。
- **被当成只读的命令，可以借参数执行或写入**，比如 `fd -x`、`rg --pre`、`git branch -D`、`git remote set-url`。这些不再跳过审批。
- **声明为只读的 MCP 工具可以并行执行**，在默认权限模式下不再请求批准。
- 工具返回的图片会发给能读图的模型，两种 OpenAI 协议都一样。
- Anthropic 的回复不再丢掉跟着内容块开头一起到的正文和思考。模型拒答时显示为拒答，不再当成空回复，也不重试。限流等待会遵守 `Retry-After`、「try again in」和 `x-ratelimit-reset-*`，最长等 60 秒。
- 深色主题下最浅一档文字从 30% 提到 50%（对比度约从 2.2:1 到 3.9:1），思维链和工具行看得清了。颜色框里手打不带 `#` 的值（比如 `1A1C1F`），色块不再变成透明。

### 移除

- 规则：规则标签页、rule 工具、纠正后建议存成规则，以及从 Cursor、Windsurf、Cline、Copilot、Codex 读取的规则。
- 手机端和「移动端同步」设置。
- 英文和简体中文以外的界面语言。中文地区统一使用简体中文。
- 代码格式化。文件面板改为只读预览，不能编辑和保存。
- 服务商的自定义请求头。OpenCode Go 需要的会话头会自动带上。
- 项目置顶（会话仍然可以置顶）、设置里的「工具」页，以及什么时候派活给子智能体的设置：改由模型自己决定，最多同时 4 个、嵌套 2 层。
- 界面和代码的字重设置、对话宽度、输入框默认高度，以及自带字体；改用系统字体。

</details>
