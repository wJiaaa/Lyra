# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.9.26](https://github.com/wJiaaa/Plume/releases/tag/v0.9.26) - 2026-10-10
<!-- plume:notes en -->

### New

- **"Send now" stops the current turn and starts over with your message.** It used to wait until the model finished the step it was on. In one real conversation that step was three and a half minutes of thinking plus a long page of HTML, so for four minutes pressing it did nothing. Now the new request goes out right away. Whatever the model had written stays in the conversation, and it reads that on the next request.
- **Replies can draw interface blocks.** A ` ```ui ` block in a reply renders as the app's own controls. A button in it sends a message for you along with the values in the block, then shows "Sent". Side chat can draw them too, and the Android app shows them read-only.
- **Page previews show up inside the conversation**, drawn while they are being written. Pages taller than 720px are folded; "Show all" opens them in place, and the corner button opens them in the panel. Local HTML files open without starting a server.
- **The terminal finds the same tools as your own terminal.** When Plume was launched from the Dock, brew, mise and starship were missing because the shell didn't start as a login shell. On macOS it now does; on Windows, Git Bash starts with `--login`, and a new terminal sees tools installed after Plume started.
- **More in the terminal:** ⌘-click (Ctrl-click on Windows and Linux) opens a URL or a path like `src/a.ts:12:3`. ⌘F or Ctrl+Shift+F finds text. Dropping a file from the Finder or the file tree inserts its quoted path without running anything. The tab shows the program running in it, and closing a terminal while a program is running asks first. Text after an emoji is no longer one column off.
- **Closing a tab in the right column closes it for good.** Side chat used to come back with its old content; now closing it deletes it, and the Reset button is gone. Shortcuts and toolbar buttons only open panels: pressing the terminal shortcut twice used to end the running shell.
- **The browser opens one page per tab.** The address bar loads into its own page; with several pages open, it used to load into whichever page the conversation had used last. Pages the agent opens run in the background until you click the card to open them.
- **The Code font menu lists monospaced fonts installed on your computer**, such as PT Mono or Maple Mono, after the presets. "(not installed)" now shows on presets you don't have. Before, every name counted as installed, even made-up ones.
- **Other apps can open a specific conversation** with `plume://open-session?id=<id>` (macOS). Notch panels like Vibe Island can now jump straight to it instead of only bringing Plume to the front.

### Fixes

- **The task list no longer stops halfway.** In one conversation all five steps were done while the list still said 1 of 5. When unchecked items haven't been updated for 10 turns, the list is read back to the model; when a turn ends with an item still in progress, the model is asked once to update it.
- **Bare file names in replies and in the terminal open the right file.** Models often write just `approvals.ts:125`, or a path relative to a subfolder. If the path doesn't exist from the project root, Plume looks for the file in the project and uses it when exactly one matches.
- Clicking a file that can't be read no longer opens an empty "Cannot read this file" tab. A message says which path it tried. "Show in the Finder" on a deleted file no longer opens the folder it used to be in.
- **The conversation hover card counts turns instead of messages.** Every tool result used to count, so one turn with forty tool calls showed eighty-odd messages. A second row shows input, output and cache reads; input plus output is the session usage.
- The cache hit rate on that card covers only the main conversation. Subagents, titles and compaction each start their own prefix, and mixed in they could hide a broken cache. A rate below 100% is no longer rounded up to 100%.
- **Expanding reasoning while it's being written no longer freezes the window.** Replaying a real 170,000-character reasoning, the window dropped to 4–6 frames per second; it now stays at 120. While it's being written, the expanded text sits in a box up to 320px tall and shows only the latest part as plain text. The full Markdown comes back when it finishes.
- The thinking row no longer shrinks back to its icon each time a new sentence starts, so clicking the middle of it no longer lands on nothing.
- A finished thinking row settles on its first sentence right away instead of waiting for the whole turn. When short bursts of reasoning come one after another, each sentence is written out and stays for about a second; before, most were cut off halfway.
- **Opening or closing the sidebar or the right column no longer makes the conversation jump.** Scrolled up, it jumped by about 120px; at the bottom, it flashed. The text column is now 864px wide and stays centered in wider panes instead of rewrapping. It no longer widens to 1120px in panes over 1280px.
- Switching between light and dark mode no longer makes the window buttons on macOS jump.
- The title of an approval card or a "Connection dropped" row can be clicked to fold it, not only the arrow at the end.
- Opening a conversation that no longer exists, from a notification for example, no longer leaves nothing highlighted in the sidebar.
- With oh-my-zsh's tmux plugin set to autostart, reading your login environment no longer times out at every launch and comes back empty.

### Removed

- **The recap above the input box**, along with `/recap` and its model setting. It spent tokens every time you opened a conversation and added them to that conversation's usage. What it already spent stays in Settings › Usage.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **「现在就发」改成停下这一轮、拿你这句话重新开始。** 以前它要等模型把手上这一步做完。真实会话里那一步是三分半的思考加一大段 HTML，按下去四分多钟没有动静。现在新请求当场发出；被停下的回复写到哪儿就留到哪儿，模型下一次请求读得到。
- **回复里能画界面块。** 回复里的 ` ```ui ` 块画成应用自己的控件，块里的按钮会替你发一句话、带上块里填的值，发过的显示「已发送」。侧边聊天也能画，Android App 上只读显示。
- **网页预览直接长在对话里**，边写边显示。比 720px 高的先折起来，「展开全部」在原地展开，右上角才开进面板。本地 HTML 不用起服务器就能打开。
- **终端里找得到你自己终端里的那些工具了。** 从程序坞启动 Plume 时，shell 没按登录方式启动，brew、mise、starship 全都找不到。现在 macOS 上按登录 shell 启动；Windows 上 Git Bash 带 `--login`，Plume 开着时新装的工具，新开的终端也能看到。
- **终端还多了几样：** ⌘ 点（Windows、Linux 上 Ctrl 点）打开网址和 `src/a.ts:12:3` 这样的路径；⌘F 或 Ctrl+Shift+F 查找；从访达或文件树拖进文件，只插入加了引号的路径，不回车执行。标签上写着正在跑的程序名，程序还在跑时关终端会先问一句。emoji 后面的字不再错开一格。
- **右栏的标签关了就是关了。** 侧边聊天以前关掉再开还是原来的内容，现在关掉即删除，「重置」按钮去掉了。快捷键和工具栏按钮只负责打开：以前按两下终端快捷键，会把正在跑的 shell 结束掉。
- **浏览器一个网页一个标签。** 地址栏只加载到自己那一页；以前开着几个网页时，会加载到会话最后用过的那一页上。agent 开的网页在后台跑，点卡片才变成标签。
- **代码字体菜单列出本机装的等宽字体**，比如 PT Mono、Maple Mono，排在预设后面。没装的预设现在会标「（未安装）」——以前任何名字都算装了，连编出来的也是。
- **别的应用能直接打开某个会话**：`plume://open-session?id=<会话 id>`（macOS）。Vibe Island 这类刘海面板点卡片时，能落到那个会话上，不再只是把 Plume 带到前台。

### 修复

- **任务清单不再停在中途。** 有个会话五步都做完了，清单还停在 1/5。现在清单有没勾的项、又 10 轮没更新，就把整张清单念给模型听；一轮结束时还有「进行中」的项，就问模型一次。
- **回复和终端里只写了文件名的路径能点开。** 模型常只写 `approvals.ts:125`，或者写相对某个子目录的路径。从项目根拼不出来时，Plume 在项目里找，只有一个同名文件才打开它。
- 点开读不到的文件，不再开出一个只写着「读不到这个文件」的空标签，而是提示一句读的是哪个路径。文件已删掉时，「在访达中显示」不再打开它原来所在的文件夹。
- **会话悬停卡片数的是轮次，不再是消息条数。** 以前每条工具结果都算一条，一轮跑四十次工具就是八十多条。卡片加了第二行：输入、输出、读缓存，输入加输出就是全程用量。
- 卡片上的缓存命中只算主对话。子智能体、起标题、压缩各起一段前缀，混在一起时主对话的缓存坏了也看不出来。不足 100% 的命中率不再四舍五入成 100%。
- **推理还在写时展开，窗口不再卡住。** 拿一段 17 万字的真实推理回放，以前窗口掉到每秒 4–6 帧，现在稳在 120 帧。写着的时候正文放在最高 320px 的框里，只显示最后一段纯文本；写完换回完整的 Markdown。
- 思考行写着时不再每换一句就缩回只剩图标，点行的中间不会点空。
- 思考写完，行马上收成第一句，不再等整轮跑完。短推理一段接一段时，每句都会写完、停留一秒左右；以前大多写到一半就被切掉。
- **开合侧栏或右栏时，对话不再跳。** 往上翻着时会一下跳开约 120px，停在底部时会闪一下。正文栏改成固定 864px，窗格更宽时居中，不再重新断行；代价是 1280px 以上的窗格里正文不再放宽到 1120px。
- macOS 上切换明暗主题时，左上角红绿灯不再上下跳一下。
- 审批卡片和「连接中断」那一行，点标题文字也能收起展开，不只是末尾的箭头。
- 从通知等地方打开一个已经不存在的会话后，侧栏里不再一个高亮的会话都没有。
- 用了 oh-my-zsh 的 tmux 插件并打开自启时，读取登录环境不再每次启动都等到超时、拿回空结果。

### 移除

- **输入框上方的会话回顾**，连同 `/recap` 和回顾模型设置。它在每次打开会话时自己花 token，还算进那个会话的用量。已经花掉的仍在「设置 › 使用统计」里。

</details>

## [0.9.25](https://github.com/wJiaaa/Plume/releases/tag/v0.9.25) - 2026-10-09
<!-- plume:notes en -->

### Before you update

- **On macOS, screen recording and other permissions have to be granted once more, and this is the last time.** The Mac build is now signed with a certificate instead of ad-hoc. macOS used to treat every update as a different app and drop its permissions; from this version on, updates keep them. The first update onto this version still counts as a different app.

### Fixes

- In the subagent panel, a tool row no longer sits flush against the thinking row after it. Rows were 0px apart there and 12px everywhere else, so the transcript read as pairs; every row is now 10px apart, the same as in the main conversation and side chat.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **macOS 上屏幕录制等权限要再授权一次，这是最后一次。** Mac 安装包改用证书签名，不再是 ad-hoc 签名。以前 macOS 把每次更新都当成另一个应用，授权跟着作废；从这一版起，更新后授权会保留。只是第一次更新到这一版时，它仍被当成另一个应用。

### 修复

- 子智能体面板里，工具行不再和下一步的思考行贴在一起。以前这两行之间是 0px、其他行之间是 12px，看上去一对一对的；现在每行之间都是 10px，和主会话、侧边聊天一样。

</details>

## [0.9.24](https://github.com/wJiaaa/Plume/releases/tag/v0.9.24) - 2026-10-09
<!-- plume:notes en -->

### Before you update

- **0.9.23 cannot update itself, so install this version by hand.** From 0.9.24 on, Plume finds and installs new versions on its own. Installers are now published on [wJiaaa/Lyra](https://github.com/wJiaaa/Lyra/releases).
- **On macOS, screen recording and other permissions have to be granted once more.** This build is signed differently from 0.9.23, so macOS treats it as a different app.

### New

- **Settings › About and in-app updates are back.** About shows the version you are on and what changed in it, and checks for a newer one: at launch and every 6 hours, or as often as you set there. When there is one, a small dot appears at the end of the Settings row in the sidebar. A download can be paused and resumed, and a package whose checksum does not match the release's `SHA256SUMS` is not installed.
- **An Android app.** `Plume-<version>-arm64-v8a.apk` connects to Plume on your computer and carries on its conversations from the phone. Pair it with the QR code in Settings › Mobile access; when the phone is not on the same network, it can go through a relay.
- **Conversations can hand work to each other.** The model can send a message to another conversation, wait for it to finish, and get the result back as the answer, without you copying text between the two.
- **Images in conversations.** The model can generate images. Images can be copied, brought into a chat from the right-click menu, or opened in a panel. Images a tool reads back show in its card; click one to see it full size.
- **Pages the agent draws are part of the reply.** They sit between the work and the answer, follow the app's theme, and are no longer folded away with the work. The model loads each page off screen first and sees a screenshot; a page that throws an error is not shown.
- **Fork from a message.** "Fork from here" on one of your messages starts a new conversation from just before it and puts that message back in the input box. The original conversation is not changed.
- **Command palette.** The magnifier at the top of the sidebar opens one dialog for finding conversations and running commands.
- **A recap when you come back.** Open a conversation that finished while you were away, and one sentence above the input box says where it got to. It stays until you start typing.
- **Smart titles, recaps and memory tidying each choose their own model** in Settings › Subagents › Conversation. Before, they read a hidden `@fast` role that nothing in Settings could change.
- **Files in replies have a right-click menu**: open in Zed, open with, reveal in Finder, copy path.
- **Something you say while the agent is working is marked as said mid-task**, so the model answers it and then carries on with the original task. If it is still writing a reply that hands work to a subagent, it answers you without waiting for the subagent to finish.
- **A new window layout.** The sidebar is back on frosted glass with its content on cards, and the title bar and icon rail are gone. The sidebar holds one list of chats; Pull requests, Scheduled and Plugins put their own navigation there. A + next to Chats starts a conversation outside any project. The right column's tabs move up into the window's title bar, the column can be collapsed, and tabs that do not fit scroll with the mouse wheel.
- Icons move a little when you hover over them.

### Fixes

- **Opening or closing the sidebar or the right column no longer makes the conversation jump.** Text used to rewrap mid-slide, the input box jumped at both ends, and the right panel shook; it now slides straight to where it ends up.
- **Test connection on Chat Completions relays no longer fails with 404**, and Gemini with reasoning off is no longer rejected.
- **A link in a reply to a file outside the project opened as "Cannot read this file".** It now opens the file.
- **On Windows, Chinese punctuation is no longer drawn in SimSun.** Chinese text size, grey and weight now match the Mac.
- **A new conversation that failed to start no longer leaves its first message in the next new conversation's input box.**
- Runtime notices, `/compact` results and project config warnings follow the interface language. A manual compaction no longer says "1 messages".
- Closing an image preview no longer puts a grey veil over the thumbnail, and the file panel no longer draws an image at full size before shrinking it into the panel.
- Coming back to a conversation no longer replays the animation at the bottom of the reply.

### Removed

- **Web access**, which opened the desktop app in a browser. The phone now uses the Android app.
- **The network access switches and allow list.** Commands and web fetches can reach public, local network and localhost addresses. The file sandbox, approval for writes and checks on fetched pages still apply.
- **Side-by-side panels.** Panels open as tabs only, and the drag handle went with them.
- The "frosted sidebar" switch, which no longer did anything to the sidebar.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **0.9.23 没法自己更新，这一版要手动安装。** 从 0.9.24 起，Plume 会自己发现新版本并安装。安装包改在 [wJiaaa/Lyra](https://github.com/wJiaaa/Lyra/releases) 发布。
- **macOS 上屏幕录制等权限要再授权一次。** 这一版和 0.9.23 的签名不同，macOS 把它当成另一个应用。

### 新功能

- **「设置 › 关于」和应用内更新回来了。** 关于页写着当前版本和这一版改了什么，并检查有没有更新：启动时查一次，之后每 6 小时查一次，间隔可以在这里改。有新版本时，侧栏底部「设置」那一行末尾会出现一个小圆点。下载可以暂停、接着下，安装包的校验值和发布里的 `SHA256SUMS` 对不上就不装。
- **Android App。** `Plume-<版本>-arm64-v8a.apk` 连上电脑上的 Plume，在手机上接着它的会话干活。在「设置 › 手机连接」扫二维码配对；手机和电脑不在同一个网络时，可以经中转连接。
- **会话之间可以互相交代事情。** 模型能给另一个会话发消息、等它做完，结果作为回答拿回来，不用你在两个对话之间来回复制。
- **对话里的图片。** 模型能生成图片；图片可以复制、从右键菜单带进聊天，或者在面板里打开。工具读回来的图片直接显示在卡片里，点开看大图。
- **agent 画的页面成了回复的一部分。** 页面排在工作过程和回答之间，跟着应用主题换色，不再随工作过程一起收起。发布前模型先在屏幕外加载一遍、看到截图；抛异常的页面不展示。
- **从某条消息分叉。** 在自己的消息上点「从这里分叉」，新会话从这条之前开始，这条回到输入框；原来的会话不动。
- **命令面板。** 侧栏顶上的放大镜打开一个弹窗，会话和命令都在里面找。
- **回来时有一句回顾。** 打开一个在你离开时跑完的会话，输入框上方一句话说明它做到了哪一步，你开始打字才收起。
- **智能标题、会话回顾、记忆整理各自选模型**，在「设置 › 智能体 › 会话」里。以前它们读的是一个设置页上改不了的隐藏角色 `@fast`。
- **回复里的文件可以右键了**：在 Zed 中打开、打开方式、在访达中显示、复制路径。
- **agent 干活时你插的话，会注明是工作中说的**，模型回应完接着做原来的事。它正在写一条派活给子智能体的回复时，你插话也不用等子智能体跑完才有回应。
- **窗口换了排法。** 侧栏回到毛玻璃上，内容各是一张卡片，顶栏和图标栏去掉了。侧栏只留一张聊天列表，拉取请求、定时任务、插件三页把各自的导航放进侧栏；「聊天」旁边的 + 直接开一段不属于任何项目的对话。右栏的标签条并进窗口顶栏，右栏可以收起，标签排不下时用鼠标滚轮横着滚。
- 鼠标移到图标上时，图标会动一下。

### 修复

- **开合侧栏或右栏时，对话不再跳。** 以前正文边滑边重新断行，输入框首尾各跳一下，右侧面板跟着抖；现在一路滑到终点。
- **Chat Completions 中转上「测试连接」不再报 404**，关掉推理的 Gemini 也不再被拒。
- **回复里指向项目外文件的链接，点开只显示「读不到这个文件」。** 现在能打开。
- **Windows 上中文标点不再是宋体**，汉字字号、灰字和粗细与 Mac 一致。
- **新对话没能启动时，开头那句话不再留到下一个新对话的输入框里。**
- 运行时提示、`/compact` 的结果和项目配置的问题都跟着界面语言走；英文界面手动压缩后不再写「1 messages」。
- 关闭图片预览时缩略图上不再罩一层灰；文件面板打开图片时，不再先按原尺寸画出来再缩进面板。
- 切回会话时，回复底部的展开动画不再重播一遍。

### 移除

- **Web 访问**（在浏览器里打开桌面应用）。手机上改用 Android App。
- **网络访问开关和白名单。** 命令和网页抓取可以访问公网、局域网和本机地址；文件沙箱、写操作审批和抓取页面的校验照旧生效。
- **面板分栏排法。** 面板只以标签页打开，拖动面板的把手一起去掉。
- 「毛玻璃侧边栏」开关，它早就管不到侧栏了。

</details>

## [0.9.23](https://github.com/wJiaaa/Plume/releases/tag/v0.9.23) - 2026-10-04
<!-- plume:notes en -->

### Before you update

- **Conversations from 0.9.22 do not carry over.** Conversations are now kept in one database, `~/.plume/sessions/sessions.db`, instead of one file each. The old files are left where they are but are no longer read, so the sidebar starts empty after updating.

### New

- **Background commands report back when they finish.** When a command started in the background exits, its exit code and output go back to the conversation: into the current turn if one is running, or as a new turn if the conversation is idle. The model no longer has to keep calling `bash_output` to check on it; one real conversation spent 6 requests doing that for 3 commands. In the conversation it shows as one line with the command, whether it succeeded, and the exit code. Clicking it opens the Tasks panel at that task, where each background task expands into a read-only terminal that follows its output.
- **"Continue" picks up the same subagent** after the app was restarted or the turn was stopped. Before, the subagent's id was lost and the model started a new one, which read the same files again. A subagent you closed in the panel stays closed after reopening.
- **Quitting during a tool call is recorded as it happened.** After a crash, a force quit, or quitting while a tool was running, reopening the conversation shows where each call stopped. A call that was running keeps the output it had printed and is marked as possibly having taken effect. A call that was waiting for approval or had not started is grey "Stopped", and the model is told it did not run. Nothing is resumed or run again by itself.
- **Subagents can open the `artifact://` and `scratch://` addresses** the main conversation passes them. They used to get "File not found". Long output cut from a subagent's context can now be read back in full.
- **Replies stream in smoothly.** Text arrives at an even pace and fades in, and half-written Markdown (bold, inline code, links) no longer flickers between two renderings. Code blocks stay fast while streaming: on a 300-line block at 150 characters a second, frames over 33ms went from 358 to 1. At the bottom of the window, the transcript follows the reply smoothly instead of jumping a line at a time.
- **Models settings, redesigned.** Providers are listed on the left, connection and models are in cards on the right. Rename and delete sit next to the on/off switch instead of in the ⋯ menu. The Test button shows the result itself: the latency when it passes, red when it fails, with the reason next to the API key.
- **New Plume icon.** The app icon has its own background, so macOS 26 no longer puts a grey plate behind it. The Dock icon is light blue or bright blue depending on the theme.
- A new project with no conversations yet has a row in the sidebar, so its first conversation can be started from there.
- Show more and show less in the sidebar now animate the list height. Rows no longer appear or vanish all at once.
- The terminal button in the title bar opens a new terminal on every press, like the side chat button. It used to stay highlighted, and a second press closed the terminal.

### Fixes

- **Tool calls from some OpenAI Responses servers could run with empty arguments.** Servers such as llama.cpp that leave out `output_index` could give one parallel call's arguments to another, and the first one ran with `{}`. A call whose arguments were cut off when the stream ended also ran with `{}`; in the case we reproduced, it was a truncated `rm -rf /tmp/build`. Each call now gets its own arguments, and a stream that ends in the middle of a call is retried.
- **Compaction summaries and memory extraction now appear in Usage.** Both cost money and were never counted.
- **Changing a global setting briefly turned off the project's `.plume/config.json`**, such as a stricter approval mode. With two quick changes in a row, an older read could also overwrite the newer setting.
- **Deleting a conversation leaves nothing behind in `~/.plume`.** Images only that conversation used, its side chats, thumbnails, and symbol indexes (a few MB each once its worktree was gone) used to stay. Images another conversation still uses are kept. Leftovers from before are cleaned up at startup, and the screenshot debug log is capped at 256KB.
- **A message could be lost right after sending it**, if Plume released the conversation as idle at that moment. The same could happen when editing and resending, or reverting to an earlier message.
- **A message you sent to a running subagent showed up twice** after switching away and back, splitting its tool-call row in two. The subagent panel could also draw a message twice now and then.
- **Opening a conversation no longer scrolls the whole history past you** when a card or image at the end loads late.
- **Settings › Index has its own project picker**, defaulting to the first project. It used to follow the open conversation, so seeing another project's index meant opening one of its conversations, and nothing showed when the open conversation had no project.
- Settings › Plugins, Subagents, Commands and Hooks now share one search box, card and row style, and the subagent and hook editors have breadcrumbs. Deleting a subagent moves it to the Trash, the same as commands and skills.
- The sidebar scrolls smoothly with many projects: with 200 projects expanded, the slowest 5% of scroll frames went from 192ms to 16.8ms.

### Removed

- The ? circle at the bottom of the sidebar, which did not open anything, and the Guide button at the bottom of the settings navigation, which only went to Models.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **0.9.22 的会话不会带过来。** 会话现在存在一个数据库 `~/.plume/sessions/sessions.db` 里，不再是一条会话一个文件。旧文件原样留着，但不再读取，所以更新后侧边栏是空的。

### 新功能

- **后台命令跑完会自己回报。** 放到后台的命令结束后，退出码和输出直接送回会话：这一轮还在跑就插进这一轮，会话闲着就开一个新回合。模型不用再一遍遍调 `bash_output` 去查——本机一个真实会话为 3 条后台命令花了 6 次请求。对话里显示成一行：哪条命令、成功还是失败、退出码多少，点它会打开任务面板并定位到那条任务；任务面板里每条后台任务都能展开一个只读终端，实时跟着输出。
- **应用重启或这一轮被停之后，说「继续」接上的是原来那个子智能体。** 以前子智能体的 id 丢了，模型只能重新派一个，把读过的文件再读一遍。在面板上关掉的子智能体，重开后也不会再回来。
- **工具调用中途退出，重开时如实交代。** 崩溃、强制退出，或者工具还在跑时退出，重开会话能看到每个调用停在哪一步：正在执行的带着已经打印的输出，标明可能已经生效；等审批的和还没开始的显示为灰色「已停止」，也告诉模型它们没有执行。不会自动续跑，也不会重跑。
- **子智能体能打开主会话交给它的 `artifact://`、`scratch://` 地址**，以前读到的是「File not found」。子智能体上下文里被剪掉的长输出，现在也能完整取回。
- **回复平滑地出字。** 字按均匀的速度出来并逐字淡入，写到一半的 Markdown（加粗、行内代码、链接）不再在两种样子之间闪。输出中的代码块也不卡：300 行的代码块、每秒 150 字，超过 33ms 的帧从 358 帧降到 1 帧。输出到窗口底部时，对话平滑地跟着上移，不再一行一顿。
- **模型设置页换了样子。** 左边是服务商列表，右边连接和模型各一张卡片。重命名和删除从 ⋯ 菜单里拿出来，常驻在开关旁边。「测试」的结果直接显示在按钮上：通过显示延迟，失败变红，原因写在 API Key 那一行。
- **新的 Plume 图标。** 应用图标自带底色，macOS 26 不会再在后面垫一块灰底；Dock 图标随主题在浅蓝和亮蓝之间切换。
- 刚建好、还没有会话的项目在侧边栏里有一行，可以从那里开第一个会话。
- 侧边栏「展开显示」和收起时，列表高度有过渡，不再整段冒出来或消失。
- 标题栏的终端按钮每点一次新开一个终端，和侧边聊天按钮一样。以前它开着就一直高亮，再点一下反而把终端关掉。

### 修复

- **部分 OpenAI Responses 服务上，工具调用可能以空参数执行。** llama.cpp 这类不带 `output_index` 的服务，并行的两个调用会串参数，前一个以 `{}` 执行；流结束时参数被截断的调用也以 `{}` 执行——我们复现的那次，原文是被截断的 `rm -rf /tmp/build`。现在每个调用拿到各自的参数，调用写到一半流就结束的，整条重试。
- **压缩摘要和记忆提取花的钱算进「使用统计」了。** 这两类调用一直在花钱，却没有记账。
- **改全局设置时，项目的 `.plume/config.json`（比如更严格的审批模式）会短暂失效**；连着改两次，旧的读取结果还可能盖掉新设置。
- **删掉的会话不再在 `~/.plume` 里留东西。** 只有这条会话用到的图片、它的侧边聊天、缩略图和符号索引（工作树清掉后每个还剩几 MB）以前都留着。别的会话还在用的图片会保留。之前留下的在启动时清理，截图调试日志最多 256KB。
- **消息刚发出去可能丢掉**：那一瞬间会话被当成闲置释放了。编辑重发、回退到之前的消息也有同样的问题。
- **发给正在运行的子智能体的话，切走再切回会出现两遍**，还会把工具调用那一行切成两段。子智能体面板偶尔也会把同一条消息画两遍。
- **打开会话时，末尾的卡片或图片晚到，不再把整段历史从眼前滚过去。**
- **「设置 › 索引库」自己选项目**，默认第一个。以前跟着当前会话走：想看别的项目，只能先去打开它的某个会话；当前会话不属于任何项目时，这一页什么都没有。
- 设置里的插件、智能体、命令、钩子四页统一成同一个搜索框、同一种卡片和行，智能体和钩子的编辑页有了面包屑。删除智能体改为移入废纸篓，和命令、技能一样。
- 项目多时侧边栏滚动不再掉帧：200 个项目全展开，最慢的 5% 滚动帧从 192ms 降到 16.8ms。

### 移除

- 侧边栏底部那个点了没反应的 ? 圆圈，以及设置导航底部只会跳到模型设置的「引导」按钮。

</details>

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
