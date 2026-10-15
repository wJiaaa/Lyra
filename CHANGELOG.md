# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.9.32](https://github.com/wJiaaa/Plume/releases/tag/v0.9.32) - 2026-10-15

<!-- plume:notes en -->

### New

- **A suggested chat gets its own card in the conversation, and can report back.** It used to leave a single "Suggested a chat" line at the end of the turn, and starting it meant finding the environment card in the top right. The chat it opened sat in the sidebar next to this one as if the two were unrelated, and its result had no way back. The card now stands where the model suggested it, on its own line; once started it shrinks to one line that shimmers while the chat runs. In the sidebar the new chat hangs under the one that suggested it. "Report back" is off by default — the model can turn it on, and you can change it on the card. When it's on, the reply that ends the new chat's first turn comes back here, marked "From chat · title". Only the first turn reports back, and not if you stopped it.
- **Previews fold to one line, like tool calls.** A preview could be resized but never folded away. It now has an icon, a title and an arrow; fold it and open it again and the page keeps its state and height.
- **Closing a side chat that has something in it asks first.** Closing a side chat deletes it, along with anything typed and not sent, and its ✕ looks just like the ones that only hide a panel. It now asks when there's a conversation, a reply in progress, or text or an attachment in the box. "Don't ask again" is only remembered if you go ahead and close it. An empty side chat, or one holding only a quoted selection, still closes straight away.

### Changes

- **The subagent panel shortcut is now ⌥⌘U (Ctrl+Alt+U on Windows).** ⌥⌘A is the screenshot key in QQ and TIM on Windows.
- **The code font menu only lists fonts installed on this machine.** A font that's in use but missing is marked "(not available here)".
- **Previews use the full width of the conversation.** The 22 px indent they inherited from tool details is gone.
- **The spinner on a running project uses the theme's accent colour.** It used the pale grey of the chat count and was easy to miss.
- **Dialog buttons in the light theme no longer look washed out.** Danger buttons used the red brightened for dark backgrounds, #f2555a, which measured 2.98:1 on its own pink tint. Light now uses #c92a30, 4.59:1 on the same tint. Cancel uses the body text colour instead of muted grey.

### Fixes

- **The gallery opens without a 300 ms skeleton first.** The first visit waited on a code chunk from local disk, and React holds a skeleton for at least 300 ms once it shows one. Those chunks are now fetched while the app is idle. Coming back to the gallery no longer re-renders an album whose list hasn't changed.
- **Images in the file panel refit when you resize it.** "Fit to panel" was worked out once, when the image loaded. After the panel grew from 396 px to 678 px, a 1600×900 image stayed at 23% in the middle with empty space all round.
- **The task list above the composer no longer jumps 12 px the wrong way when the subagent bar opens or closes.** The composer's top margin switched in one frame while the bar grew over 340 ms; the two now move together.
- **Code blocks, formulas and Mermaid diagrams wider than the column get a thin scrollbar on hover** that you can drag.
- **Image annotations are sharp on Retina, and the toolbar can be dragged out of the way.** Lines and text are sized in screen points, and the canvas is drawn at screen resolution.
- **Stacked subagent avatars no longer let the face underneath show through.**
- **`glob` understands `[abc]`, `[a-z]` and `[!x]`.** `glob src/**/*[Pp]review*` answered "No files match" while `PreviewCard.tsx` was right there, and the model spent two more rounds switching between grep and glob.
- **`grep` on a path that doesn't exist says so.** A `path` of `ToolCall.tsx` (the file is `ToolCard.tsx`) came back as "No matches", and the model concluded the file didn't contain what it was looking for.
- **`ls skill://…` lists skill directories.** `ls skill://huashu-art-motion/references` said "Not a directory or not found" although the directory was there, and `read skill://x/references/` with a trailing slash said there was no `references/`.
- **Windows:**
  - After maximising or restoring, the title bar's buttons on the right are no longer covered by the system buttons.
  - Panels and split view no longer get a system title bar.
  - A dialog's backdrop dims the system buttons too, and nothing under it can drag the window.
  - Ctrl+V pastes in the terminal.
  - Opening the same file through two spellings of its path opens it once.
  - The window remembers being maximised and no longer grows a few pixels each launch.
  - Ctrl+M no longer minimises the window.
  - Shortcut hints say Win and Backspace.
  - Bold Markdown uses semibold, and the code font falls back to Microsoft YaHei for Chinese.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **建议的新会话在对话里自成一张卡片，跑完可以交回结果。** 从前一轮末尾只留一句「建议了新会话」，要开始得去右上角的环境卡片里找；开出来的会话在侧栏里和提建议的对话并排，看着像两件不相干的事，结果也没法拿回来。现在卡片就站在模型提建议的位置、自成一行，开始以后缩成一行，在跑的时候有一道扫光。侧栏里新会话挂在提建议的那个会话下面。「交回这里」默认关，模型可以打开，你在卡片上也能改；打开时，新会话第一轮最后那段回复会送回这里，标着「来自新会话 · 标题」。只交第一轮，被你停下的不交。
- **预览能像工具行一样收成一行。** 从前预览只能调高度，收不起来。现在有图标、标题和展开箭头，收起再展开，网页的状态和高度都还在。
- **关掉有内容的侧边聊天之前先问一句。** 关侧边聊天就是删掉它，连同框里没发出去的字；而它的 ✕ 和别处只收起面板的 ✕ 长得一样。现在里面有对话、正在回答，或者框里打了字、贴了附件时，点 ✕ 先弹确认框。「不再询问」只在你真的关掉时才记住。空的侧边聊天，或者只挂着一段划词引文的，照旧一点就关。

### 变化

- **子智能体面板的快捷键改成 ⌥⌘U（Windows 上 Ctrl+Alt+U）。** ⌥⌘A 在 Windows 上是 QQ、TIM 的截图键。
- **代码字体菜单只列这台机器装了的字体。** 正在用却没装的那个，标「本机不可用」。
- **预览占满对话的宽度。** 从工具详情沿用过来的 22px 左缩进去掉了。
- **项目运行中的加载圆环用主题强调色。** 原来跟着会话计数用淡灰色，不仔细看注意不到。
- **浅色主题下弹窗按钮不再发虚。** 危险按钮沿用了给深色底提亮的 #f2555a，压在它自己的浅粉底上只有 2.98:1；浅色现在单独用 #c92a30，同样的底上 4.59:1。取消按钮的字从次要灰换成正文色。

### 修复

- **第一次打开画廊不再先挂 300ms 骨架。** 第一次进要等本机磁盘上的一个分包，而 React 一旦露出骨架，至少留它 300ms。现在这些分包在空闲时先取好。再次进入画廊时，列表没变的相册不再整本重新渲染。
- **拖宽拖窄文件面板，图片跟着重新适配。** 「适应面板」只在图片载入那一刻算一次：面板从 396px 变成 678px 后，1600×900 的图还按 23% 缩在中间，四周大片空白。
- **子智能体条展开收起时，输入框上方的任务清单不再先反向跳 12px。** 输入框的上边距一帧就切过去，而条要 340ms 才长出来；现在两者合成一次移动。
- **代码块、公式、Mermaid 图比栏宽时，指针移上去有一条能拖的细滚动条。**
- **图片标注在 Retina 上不再发虚，工具栏能拖开。** 线和字按屏幕点数定大小，画布按屏幕分辨率画。
- **叠在一起的子智能体头像，下面那张脸不再透上来。**
- **`glob` 认得 `[abc]`、`[a-z]`、`[!x]`。** `glob src/**/*[Pp]review*` 答「No files match」，而 `PreviewCard.tsx` 就在那里，模型在 grep 和 glob 之间来回又多走两轮。
- **`grep` 搜不存在的路径时直说找不到。** `path` 写成 `ToolCall.tsx`（实际叫 `ToolCard.tsx`），交回去的是「No matches」，模型据此以为文件里没有要找的东西。
- **`ls skill://…` 能列技能目录。** `ls skill://huashu-art-motion/references` 目录明明在，却报「Not a directory or not found」；`read skill://x/references/` 带尾斜杠时说没有 `references/`。
- **Windows：**
  - 最大化、还原以后，标题栏右侧的按钮不再被系统按钮盖住。
  - 面板和分屏不再带系统标题栏。
  - 弹窗的遮罩把系统按钮也压暗，遮罩下面拖不动窗口。
  - 终端里 Ctrl+V 能粘贴。
  - 同一个文件换一种路径写法，不再开出第二格。
  - 窗口记得自己是最大化的，也不再每次启动长大几像素。
  - Ctrl+M 不再把窗口最小化。
  - 快捷键提示写 Win、Backspace。
  - Markdown 加粗用 semibold，代码字体的中文回退到微软雅黑。

</details>

## [0.9.31](https://github.com/wJiaaa/Plume/releases/tag/v0.9.31) - 2026-10-15

<!-- plume:notes en -->

### New

- **Subagents are let go as soon as they're dispatched, and each reports back when it finishes.** `task` used to wait for its subagents unless you spoke up, so with three running in parallel the main agent sat silent until the slowest was done, then all three conclusions came out in one paragraph. Dispatching now returns "dispatched", the turn wraps up, and you can keep talking. Each result is delivered as it comes back — ones that land within 400 ms of each other share a turn — naming who is still out and saying only what this one brought; when the last is in, they are merged into one answer. Whatever waits for the conversation to go idle (`wait_for_session`, archiving, idle compaction, the CLI, the "done" notification) waits for the last one. Subagents still running when Plume quits are interrupted, and the main conversation is told so the next time you speak. The price is requests: three subagents coming back separately take the main conversation from 2 requests to 5.
- **Tool calls in a row read as one line that grows.** Consecutive calls merge into one line that counts from the first call — "Read 2 files, listed 4 directories" — and new calls are added at the end, so the words already there stay put; the width eases over, and the arrow and +N −M at the end slide along instead of jumping. Read-only shell commands (`rg`, `sed -n`, `git log`: every piped segment read-only, no redirect into a file) belong to the same exploring line as reading files. Editing, exploring and terminal work next to each other merge too, so "edit failed → `sed -n` → python → edit failed → read → edit" is one line instead of six. The browser, dispatch and preview only merge with their own kind, and the model saying something still starts a new line. The expanded/collapsed "Tool calls" switch in Settings → Appearance is gone.
- **A running line says which call it's on.** It used to show totals ticking up — "Read 12 files, searched 5" — so a minute of exploring told you nothing about which file it was looking at. While running it names the first call still in progress and holds each phrase for at least 650 ms, so reads and greps 100–200 ms apart don't roll past before you can read them; once an answer or other work follows, it rolls over to the totals. `read`, `grep`, `glob` and `ls` take an optional description, and when the model writes one it is shown, as with bash; otherwise it falls back to "Read a.ts".
- **Split view looks like two screens.** The gap between screens was as wide as the one between a conversation and its panels, so a terminal on each side made four identical cards with no telling which two belonged together, or which screen had focus. Each screen is now one card with the conversation on it and the tab bar floating inside (6 px from the card's edge, 3 px from the conversation, outlined, no shadow). The unfocused screen's content is a step dimmer, its composer one more, and its title grey. A single screen is unchanged.

### Changes

- **The model's reasoning is hidden by default.** It is a draft the model writes for itself and often runs longer than the answer. Settings → General → "Show reasoning" brings it back, in the main conversation and subagent panels alike; the bottom of the chat still says when the model is thinking.
- **No more "Worked N s" line over each turn.** The steps lie flat in the conversation with the answer at the end, and nothing folds itself away when the turn finishes. The line repeated the number the running indicator already shows, and for models that don't stream reasoning — GPT through a proxy, say — it took ages to appear and arrived already at tens of seconds. A turn woken by a finished subagent or background command doesn't get a second header on top of the delivery line either.
- **The task list opens expanded.** Collapsed, it showed only the current step, and how many are left and what comes next — what the card is there for — took a click. Clicking the title still folds it to one line.
- **Icons no longer animate on hover.** They are plain lucide icons now; the 218 animated versions are gone, along with the `motion` dependency they needed.
- **Corners and shadows come from one scale.** There were 22 radii in use, with 10, 11, 13 and 14 px side by side. 10 px corners (settings cards, tool cards, code blocks, gallery tiles) are 8 px now, 18 px ones (the message editor, slash and @ menus, the commit dialog) 16 px, and 11/13/14 px ones 12 px. Segmented controls are the same everywhere — 8 px outside, 6 px on the thumb — where the plugin page's tab strip and scope buttons were pills beside small-cornered controls on the same page.
- **Secondary text is darker on menus and cards.** The two greys were tuned to the page background and washed out on lighter surfaces: muted text measured 3.9:1 on a dark menu, faint text 2.3:1 in the light theme. Muted is now at least 4.5:1 on every surface and faint at least 3:1. Windows' light theme used to get one extra step darker on its own; every platform now sits above that.
- **The sidebar's top and bottom rows aren't greyed out.** They faded towards the edges, which looked like something lying over them; the project heading and the settings row are solid already and rows pass beneath them.
- **The conversation fades 32 px at the top and 48 px at the bottom, all the way down to the composer.** In dark themes a light image or preview card scrolled to the top edge picked up a dirty dark band from the 36 px mask. The composer also kept a fixed 12 px top margin, so the fade stopped short and left a strip above it; that margin is now 0 unless an approval card, hook banner or task list sits there.
- **Updates come from `wJiaaa/Plume`.** The repository was renamed from Lyra. Update checks and the release link in Settings → About use the new name instead of relying on GitHub's redirect.

### Fixes

- **A preview that is checked before publishing stays where it is.** Checking and publishing are two calls with a whole round of the model's thinking in between: the draft vanished once the check finished, the conversation sat empty for ten-odd seconds, then the page turned up somewhere lower down. 115 of the 139 preview calls on this machine were checks, so this happened to nearly every page. The draft now stays in place marked "checked, not published yet", and the published page fades in on the same spot. If the turn ends unpublished the draft goes away; a page published in a later turn is still drawn there.
- **A terminal opened once in an empty conversation no longer comes with every new one.** Sending the first message copied the empty conversation's panels to the new session and left the copy on disk, so every later "New conversation" brought that terminal, and so did everything sent from it. Switching back to that session from an empty conversation also kept bringing closed terminals back.
- **Paths from `grep` and `glob` with a `path` can be read.** They were written relative to the searched directory while `read` and `edit` resolve against the workspace root: a grep with `path: "src"` reported `pages/Login/index.tsx`, `read` said File not found, and the model spent a round with glob finding `src/` again. Results are relative to the workspace root now, and absolute when the searched directory is outside it.
- **`ls` and `preview` understand `scratch://`.** `ls scratch://` said "Not a directory or not found", and `preview scratch://todo-templates.html` went looking for `<project>/scratch:/todo-templates.html`.
- **Models whose thinking can't be switched off get conversation titles.** The title request asks for no thinking and 60 output tokens. DeepSeek V4 Flash through magpie only offers low/high/max, so it thought at low, spent all 60 tokens on reasoning and left the title empty — all 34 attempts in the logs here. Such models get 2048 tokens now; models that can switch thinking off still get 60.
- **Dialogs no longer twitch after opening.** A centred card often lands on half a pixel, and when the opening animation ended the text snapped to the pixel grid about a quarter of a device pixel away. Opening now scales up from 0.95 and fades in over 150 ms (closing reverses in 100 ms), instead of rising 6 px, which made a centred card look like it drifted in from below.
- **Double-clicking a word no longer pops the quote menu in the way of a triple-click.** The menu opened right after the second click, closed on the third and opened again on the paragraph. A double-click now waits 400 ms first; dragging and triple-clicks open it immediately. A single selected character no longer counts as a quote.
- **Expanding history no longer makes +N −M and the failed and stopped marks bounce.** The pop is for a tool finishing in front of you; cards that only appeared because you expanded a group played it too.
- **The file path pinned at the top of the changes panel isn't faded out.** The panel's 36 px top fade swallowed the 38 px sticky file header as soon as you scrolled.
- **A second terminal's header and border follow the code theme.** Only the first terminal and file panel matched, so under Dracula or Solarized later ones had a window-coloured frame around a differently coloured terminal. The default dark theme happens to use #171717 for both, which hid it.
- **The idle ring in the conversation list is visible in dark mode.** It measured 1.09:1 against the sidebar; it is 1.27:1 now, and 1.21:1 in light.
- **Clicking a project row no longer flashes.** Pressing it darkened the row and releasing it undid that, on every expand and collapse; it keeps the hover colour while held.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **子代理派出去就放手，跑完一个送回一个。** 从前 `task` 默认等子代理交差，只有你插话才放手：并行派三路时，主智能体一声不吭地等最慢的那一路，三路的结论最后挤在一段话里出来。现在派出去就回一句「已派出」，这一轮先收尾，你可以接着说话。每回来一个送一份，前后脚 400ms 内回来的合成一轮；还有没回来的就点名在等谁、只说这一份带来了什么，全回来了再合成一份回答。等会话闲下来的那些（`wait_for_session`、归档、闲时压缩、命令行、「做完了」的通知）都等最后一个回来。退出 Plume 时还在跑的子代理会被打断，你下次开口时主会话会知道。代价是请求数：三路分开回来，主会话的请求从 2 次变成 5 次。
- **连着的工具调用合成一行，往句尾接。** 一行从第一次调用起就说累计的「读取文件 2 个、列出目录 4 个」，新的调用接在句尾，前面的字不动；宽度缓过去，行尾的箭头和 +N -M 是被推过去的，不是跳过去的。`rg`、`sed -n`、`git log` 这类只读命令（管道里每一段都只读、没有写文件的重定向）和读文件归成同一行探索。改代码、探索、终端挨在一起也合：「edit 失败 → `sed -n` 看一眼 → python 改 → edit 失败 → read → edit」从六行变成一行。浏览器、派发、预览仍然只和同类合，模型说了话照旧另起一行。设置 › 外观里「调用链」的展开 / 折叠开关删掉了。
- **跑着的那一行说正在跑的那次调用。** 从前跑着时只说总数「读取文件 12 个、搜索内容 5 个」，一段探索跑一分钟，只看得到数字在涨，不知道它正在看哪个文件。现在说的是第一个还在跑的调用，每一句至少停 650ms——连着的 read、grep 一两百毫秒一换，不停一下字还没读完就滚走了；后面接上回答或别的活，再滚成总数。`read`、`grep`、`glob`、`ls` 多了可选的说明，模型写了就用它，和 bash 一样；没写退回「读取文件 a.ts」。
- **分屏时看得出是两屏、焦点在哪一屏。** 从前屏与屏之间的缝和屏内对话、面板之间的缝一样宽，两屏各开一个终端就是四张一样的卡，看不出哪两张是一组，也不知道自己在哪个会话下面。现在每一屏是一张卡，对话铺在上面，标签栏浮在屏卡里（离边 6px、挨对话一边 3px，只有描边不投影）。非焦点屏的内容淡一档、输入框再淡一档，标题变灰。单屏不变。

### 变化

- **对话里默认不再摊开模型的推理。** 推理是模型写给自己的草稿，常常比回答还长。设置 › 常规 →「显示思考过程」可以打开，主会话和子智能体面板同一个开关；模型在想的时候，底部的运行指示照旧会说。
- **不再给每一轮挂「已工作 N 秒」那一行。** 过程一行行摊在对话里，回答跟在最后，跑完也不自己收起。那一行说的和底部运行指示是同一个数，而经代理的 GPT 这类不流推理的模型，它要么迟迟不出，要么一出来就是几十秒。子智能体或后台命令跑完叫醒的那一轮，也不再在送达那一行上面多挂一个标题。
- **任务清单默认展开。** 收起时只看得到当前那一步，「还剩几步、接下来做什么」正是这张卡片要回答的，却得先点一下。点标题照样能收成一行。
- **悬停时图标不再动。** 统一用 lucide 原版，218 个动画版图标和只为它们装的 `motion` 依赖一起删掉了。
- **圆角和阴影收成一套刻度。** 从前界面里有 22 种圆角，10、11、13、14px 并排出现。现在 10px 那一组（设置卡片、工具卡片、代码块、画廊方块）是 8px，18px 那一组（消息编辑框、斜杠和 @ 菜单、提交弹窗）是 16px，11/13/14px 是 12px。分段控件处处一样：外框 8px、滑块 6px——插件页的标签条和范围按钮从前是胶囊，同一页上别的分段控件是小圆角。
- **次要文字在菜单、卡片上更深了。** 两档灰原来按页面底色定，落到更浅的表面上就发灰发飘：深色菜单上次要文字只有 3.9:1，浅色下最浅那档只有 2.3:1。现在次要文字在每种表面上都 ≥4.5:1，最浅那档 ≥3:1。Windows 浅色原来单独多深一步，现在所有平台都在那一步之上。
- **侧边栏上下两头的行不再像盖了一层灰。** 两头原来往边上淡出，看着像被什么压住；项目标题和底部设置行本来就是实心的，行是从它们下面穿过去的。
- **会话区渐隐收成顶 32px、底 48px，一直淡到输入框边上。** 深色主题下，浅色图片、预览卡滚到顶边，会被 36px 的遮罩压出一条发脏的暗带。输入框上方原来固定留 12px，渐隐到它上面就停了，中间空出一条；现在只有对话时这 12px 收掉，上面叠着审批卡片、Hook 提示条或任务清单时照旧留着。
- **更新改从 `wJiaaa/Plume` 取。** 仓库从 Lyra 改了名，更新检查和设置 › 关于里的发布页链接都换成新名字，不再靠 GitHub 的重定向。

### 修复

- **先检查再发布的网页预览，不再写完就消失、再在下面另起一张。** 检查和发布是两次调用，中间隔着模型一整轮推理：检查完草稿就撤了，对话里空着十几秒，页面再换个位置出现。本机 139 次 preview 调用里 115 次是检查，几乎每一页都这样。现在草稿留在原地、标着「检查过了，还没发布」，发布的页面就在那个位置淡入接上。这一轮结束还没发布的，草稿撤掉；隔一轮才发布的，页面仍画在发布那里。
- **空白对话里开过一次终端，之后的新对话不再都带着它。** 发出第一条消息时，空白对话摆好的面板是抄给新会话的，草稿那份留在盘上，于是之后每个「新对话」都带着那个终端，从它发出去的会话也一个个继承。从空白对话点回那个会话时，关掉的终端也会再冒出来。
- **grep、glob 带 `path` 搜出的路径，拿去读不再报找不到。** 结果原来相对搜索目录写，而 `read`、`edit` 按工作区根解析：grep 带 `path: "src"` 报出 `pages/Login/index.tsx`，原样去读得到 File not found，又要搭一轮 glob 才找回 `src/`。现在都相对工作区根写，搜索目录在工作区外时给绝对路径。
- **`ls`、`preview` 也认 `scratch://`。** 从前 `ls scratch://` 报「Not a directory or not found」，`preview scratch://todo-templates.html` 去找 `<项目>/scratch:/todo-templates.html`。
- **关不掉思考的模型也能生成会话标题。** 标题请求要求不思考、输出上限 60。经 magpie 接入的 DeepSeek V4 Flash 只有 low/high/max 三档，「不思考」被就近提到 low，60 个 token 全花在推理上，标题是空的——本机日志里它的 34 次全是这样。这类模型现在给 2048，能关思考的仍是 60。
- **弹窗打开后文字不再抖一下。** 居中的卡片常落在半像素上，进场动画一结束，文字重新对齐像素网格，挪了约四分之一个设备像素。进场也改成从 0.95 倍原地放大、淡入（150ms），退场反过来（100ms）；原来往上升 6px，一个居中的卡片看着像从下面飘上来的。
- **双击选词不再立刻弹出划词菜单、打断三击选段。** 从前第二下松开就弹，接着点第三下时菜单先被收起、松开又在整段上弹一次，一次三击闪两回。现在双击先等 400ms，拖选和三击照旧立刻弹。只选中一个字不再算引文。
- **展开历史时，+N -M 和失败、停止的标记不再弹一下。** 那一下是给眼前刚跑完的工具的，展开分组时才出现的卡片也跟着播了。
- **文件变更面板滚动后，钉在顶上的文件路径不再被淡掉一截。** 面板 36px 的顶部渐隐，一滚动就把 38px 高的文件头整个盖进去。
- **第二个终端的标题栏和边框也跟代码主题走。** 从前只有第一个终端和文件面板换底色，换成 Dracula、Solarized 这类主题时，后开的那个是一圈窗口底色套着一块别的颜色。默认深色主题下两者恰好都是 #171717，所以一直没露出来。
- **深色模式下，会话列表空闲态的状态圆环看得见了。** 从前在侧栏上只有 1.09:1，现在 1.27:1，浅色 1.21:1。
- **点项目行不再闪一下。** 按下时底色加深、松手退回，而点项目行就是在折叠展开，每点一次闪一次；现在按住和悬停同色。

</details>

## [0.9.30](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.30) - 2026-10-14

<!-- plume:notes en -->

### New

- **Worktrees belong to a conversation now, and a conversation can hand its work back.** A new conversation's composer carries a ⑂ switch; the switch in settings is only the default, and what you pick travels down with the first message. The conversation stays filed under the project it came from instead of growing a same-named project beside it, and a worktree that couldn't be created says so in amber on the composer rather than quietly working in the project directory. From the ⑂ chip (`⑂ branch ↑2 ↓1`) you can merge the conversation's commits back into main and pull main's new ones in: `--no-ff` in place when the project is checked out here, without a checkout when it is checked out nowhere, refused when another worktree holds the branch. A merge conflict aborts at once and leaves the project as it was; a sync conflict stays in the worktree for you to settle or abandon. Leading and trailing counts don't count merge commits.
- **Deleting or archiving a conversation takes its worktree with it.** Neither used to touch the worktree, so `~/.plume/worktrees` only ever grew; the automatic cleanup couldn't tell which worktrees Plume had made, skipped only the sessions running in memory, and ran with `--force`, so uncommitted work went with it. A worktree with uncommitted changes in it is not reclaimed now, and the delete confirmation says what stays behind; un-archiving checks it out again where it was. The automatic cleanup only reclaims clean `plume/session-*` worktrees that no unarchived conversation is using, and never with `--force`.
- **Tab fills in a guess at your next message.** Off by default — Settings → General → "Next-step suggestions" — because it costs one more request per turn. It is forked from the request just sent, so it mostly pays for cache reads, and it isn't sent at all when the last request neither read nor wrote the cache, since that would re-read the whole conversation at full price. It reads the end of the reply for what's next and what your options are, keeps to what you asked for, and guesses nothing when the turn failed or the conversation has fewer than two replies.
- **The model dialog filters by vendor.** With a few relays configured there are thirty models in one list, and searching by name means knowing how each relay spells it. The vendor rail on the left — All / Favourites / each vendor — pools a maker's models across providers while still grouping by provider, and appears once there are eight models from at least two vendors. Focus stays in the search box: typing highlights the first match, ↑/↓ move, Enter takes it, and an Enter that belongs to an IME is left alone.
- **An interface block has a shape while it is still being written.** A chart or a table used to be blank until the data had finished streaming, then appear in one frame. A placeholder stands where the tag is going: dot matrix, ripple, probe line, dashed frame with corner handles. When the tag closes, charts and tables are first traced along their own frames, grid lines, bars and cells, and a line sweeps down to reveal them; the rest of the block is simply revealed. Containers get neither — measured by height, the whole card would be hidden as one element and what was written into it wouldn't show until the sweep reached it. (The look is from transitions.dev's generation effect, reimplemented here without its size labels, counters and coordinate readouts.)

### Cheaper

- **Summaries cost about a quarter of what they did.** On this machine the same conversations asked for 315 and now ask for 82: the first summary waits until you have said three things, and then two more each time; messages the runtime writes in — a subagent's result, mail from another conversation — are not you saying something. Half of the 187 conversations here have exactly one thing said in them, and the title already says what that was.
- **They are no longer spent just for opening a conversation.** The renderer clocked the request while the environment card was open, so opening a long-finished conversation spent one immediately, and a conversation actually working got none unless you opened the card. The main process generates it now, a minute after a turn ends with nothing following — a next turn cancels it, and a turn still running at the minute doesn't get one. The card reads what has been stored and listens for the new one; with no summary it takes up no room, and a failure leaves a "Retry".
- **The agent reads web pages for less.** `read` returns its elements one per line with a ref, about 28% of the size it was, and screenshots come out in CSS pixels, which is three-quarters fewer tokens on a Retina display.

### Changes

- **The system prompt no longer invites abstractions and defensive code.** Three similar lines beat a premature abstraction, and a helper with one call site is a change made bigger for nothing. Validation goes at the boundaries — what you typed, what an API returned — not around internal calls that cannot fail.
- **A dropped connection gives up after ten attempts, about four minutes.** It used to retry without a limit, one attempt every five seconds: one run on this machine couldn't reach a relay (ECONNREFUSED), resent 646 times and hung for 54 minutes while the conversation showed "running" and messages queued behind it. Ten attempts, backing off from 5 seconds to 30, rides out a network switch or a VPN reconnect, and "unlimited" is still an option. Fixed while there: normalisation dropped a missing strategy into `fixed` instead of leaving the family's own default, which would have quietly turned the new backoff back into every five seconds. A settings file saved before this keeps its old value — nothing is migrated.
- **A chart of data you already have goes into an interface block.** Asked to summarise something as a chart, the model read `plume://preview` and wrote an HTML page for data that was in hand. Both the preview tool's description and the interface-block prompt claimed "a chart", and the tool's description is much longer, so it always won. The chart example is out of preview's description, which now points at ```ui; diagrams, interactive tables, little games and layout drafts stay with preview.
- **Three rows that no longer earned their place are gone from the model dialog:** "Close thinking" (reasoning effort already has "Off"), "Manage providers and models", and "Make default for new conversations" — the default belongs in Settings → Models, and what you pick with no conversation open is the default anyway.

### Fixes

- **Writing a file outside the project asks, instead of being refused and then written through the shell.** `write` and `edit` refused anything outside the workspace root with "Path escapes the workspace root", while `bash` writing outside was only a `write-outside-project` risk that one click cleared. Told to save a file on the desktop, the model was refused and turned around with `cat > … <<EOF`: the door stopped nothing and pushed the write off the path that keeps a diff card, reads before it writes and records the change. It goes through the approval the tool already knows how to ask for: every time in "ask", judged as write-outside-project in "auto", not at all in "full", the same as bash. Two places still refuse — `~/.plume` outside the scratch directory, where settings, credentials and skills live, and a symlink inside the project that points outside it, because the card shows the path it was handed (the error now gives the real one).
- **The main agent stops waiting on a subagent when another conversation writes in.** Only you speaking made it let go and read what had arrived; mail another conversation sends with `steer` is written by the runtime, so it sat unread until every subagent had handed in — and a long turn waits on a subagent for seven-odd minutes here, while the sender is usually sitting in `wait_for_session` waiting for exactly that. One rule covers both now. Background results still don't let go — a subagent let go of would release the ones waiting beside it — and neither does mail queued for after this turn.
- **Video and audio in the file panel can seek.** Every file went through `net.fetch(file://)`, answered 200 with the whole file, and with no Range response Chromium decides the source can't seek: `seekable` was [0, 0] and dragging the bar or setting `currentTime` snapped back to the first frame. Audio and video are answered 206 with `Content-Range` and `Accept-Ranges`, 416 past the end; everything else takes the old path.
- **Opening a page in the built-in browser no longer reports that the panel isn't ready, and a crashed page no longer takes Plume down with it.** A site that didn't answer within 30 seconds failed with "the browser panel wasn't ready within 30 seconds", because the panel only checked in with the main process once the page was dom-ready; it checks in on did-attach now, and the "document ready" wait the agent needs is separate — 30 seconds, then the site is reported unreachable with its tab left open. A renderer crash segfaulted Plume's main process, in shipped versions too (killing the page process reproduces it): the panel added an error row that made the page shorter, then resized a guest that no longer existed. Zoom and viewport are applied to the page by `applyView`, skipping a crashed one; the first crash reloads by itself, and a second within 15 seconds stops on the error. Failures and crashes are a layer over the page area that says why and offers a reload instead of pushing the page around, and the failed state clears when you navigate.
- **Dialogs nobody could answer no longer cost the agent 15 seconds each.** A page's `alert`, `confirm` or before-unload prompt made every step wait its full 15 seconds and a new tab 30, because the renderer can't answer the system dialog Electron puts up; agent-side calls answer it now and write the answer into the result. `read` returns elements one per line with a ref, numbered across tags, and a ref from an older page reports itself stale rather than clicking the wrong thing. A click checks the target is visible, enabled, not moving and not covered, waiting up to 3 seconds and naming whatever covers it. `back`, `forward`, `reload` and `wait` — for text, an element or an expression, across a navigation — are there, and clicking a link no longer waits 15 seconds for nothing. `browser_open` says why a site wouldn't open instead of handing back a blank error page.
- **A path typed into the address bar works with "Open in external browser".** The button only knew about the page the tab had loaded, so with `~/Desktop/…html` typed and no Enter pressed on a blank tab it stayed grey — and pressing it blurred the input, which restores the page's address, which on a blank tab is nothing. What you have typed is handed over now, and with nothing typed it is what's on screen; the button no longer takes focus away. Addresses still pass through the main process: web addresses go to the system, local paths have `~` expanded and only `.html` opens.
- **The line for a message from another conversation is no longer bold from end to end.** Every step row's title is `font-medium` and the others are two or three words ("Thinking"), where that reads as a label; this one holds "From + conversation title", so it read as one long bold line, louder than the summary. "Open this conversation" also sat at the bottom of the expanded body, so you had to read the whole message to find it — it is a permanent icon button at the end of the line now, with the same tooltip.
- **GLM models show Zhipu's Z instead of a neutral square.** The brand table had no Zhipu and nothing matched an id like `opencode-go/glm-5.3-flash`, so those rows drew the placeholder. The mark comes from z.ai's favicon — bigmodel.cn uses the same Z — with the dark rounded plate taken off, so it works as a single-colour mark like OpenAI's.
- **With reduced motion, an interface block is no longer clickable before it has finished writing.** Its "writing" state rode on `fade`, and `fade` doesn't light up when motion is reduced.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **工作树跟着会话走，会话也能把活交回来。** 新会话的输入框上多了一颗 ⑂ 开关，设置里那个原来全局的开关退成默认值，选的结果随第一条消息下去。会话建好后仍归在原来的项目下，不再每开一个就在侧栏多一个同名项目；工作树没建成时，输入框上一直挂一条琥珀色提醒，而不是一声不吭地回到项目目录里改。从 ⑂ 芯片（`⑂ 分支 ↑2 ↓1`）可以把会话里的提交合回 main、把 main 的新提交拉进来：项目正好检出在这里时就地 `--no-ff` 合并，哪里都没检出时不动工作区就合，分支被别的工作树占着时拒绝。合并冲突立刻 abort、项目原样留下；同步冲突留在工作树里，交给你处理或放弃。领先落后不算合并提交。
- **删掉或归档会话，工作树跟着收回。** 从前删除和归档都不管工作树，`~/.plume/worktrees` 只增不减；自动清理也认不出哪些是自己建的，只放过内存里在跑的会话，而且带 `--force`，没提交的改动跟着一起没了。现在有没提交改动的目录不收，删除确认框里画出会剩下什么；取消归档照原样检出回来。自动清理只收 `plume/session-*` 里没有未归档会话在用、且干净的，不再带 `--force`。
- **Tab 填入猜的下一句。** 默认关，开关在 设置 → 常规 →「下一步建议」：每轮多一次请求，开不开你自己定。这次请求从刚发出去的那次分叉，基本只付缓存读的钱——上一次请求既没读也没写缓存时干脆不发，那等于整段对话按原价重读一遍。它读回复末尾写了什么下一步、有哪些选项，以你原本要的为准；这一轮出过错时不猜，只说过两轮的对话也不猜。
- **模型弹窗按厂商筛。** 接了几个中转之后二三十个模型挤在一个列表里，而按名字搜的前提是你知道这个中转是怎么拼它的。现在左边一列厂商（全部 / 收藏 / 各家），点一下只看这一家，跨供应商汇总、仍按供应商分组；模型少于 8 个或只来自一家时不显示这一列。焦点一直在搜索框里：打完字高亮落在第一个匹配上，↑/↓ 移动、回车选中，输入法组字时的回车不算。
- **界面块在写的时候就有形状。** 图表、表格这类要等数据整段写完才画的块，从前在那之前一片空白、写完又在同一帧整块冒出来。现在还没写完的标签先在那个位置立一块点阵占位（涟漪、探针线、虚线外框和四角手柄）；写完时图表和表格先按自己的外框、网格线、柱子、单元格描一遍虚线，再由一条线自上而下揭开，其余元素只揭开。容器不给占位也不描线——按高度判断时整张卡片会被当成一个元素藏起来，后面写进去的内容要等线扫到才看得见。外观参考 transitions.dev 的 generation 效果，自己实现，不带它的尺寸标签、计数和坐标读数。

### 更省

- **摘要的请求量降到约四分之一。** 本机同样的会话从前要 315 次摘要，现在 82 次：第一次要等你已经说过三句，之后每多两句才再要一次，子 Agent 结果、别的会话发来的信这些运行时写进去的消息不算你说的。本机 187 个会话里一半只说过一句，而标题已经说清了那是什么。
- **也不再为「点开一个旧会话」花掉一次。** 从前是环境卡片开着的时候由渲染层掐表去要：点开一个早就停下的旧会话立刻花一次，而真在干活的会话不点开卡片就一直没有。现在主进程在每轮结束、一分钟内没有下一轮时自己在后台生成——下一轮开始就撤掉，到点还在跑也不要。卡片只读存着的那份、听推来的新一份，还没有摘要时整节不占位，失败了留一颗「重试」。
- **agent 读网页更省。** `read` 的元素一行一个、带 ref，体积降到原来约 28%；截图按 CSS 像素出图，Retina 上少花四分之三的 token。

### 变化

- **系统提示词不再鼓励用不上的抽象和兜底。** 三行相似的代码好过过早的抽象，只用得着一次的 helper 是把改动撑大。校验只放在用户输入、外部 API 这类真正的边界上，不给不可能失败的内部分支加兜底。
- **断线重试十次、约四分钟后报错。** 从前默认无限重试、每 5 秒一次：本机有一次连不上中转（ECONNREFUSED），重发了 646 次、挂了 54 分钟，期间会话一直显示在跑、发给它的消息都排着。现在默认重试 10 次、5 秒起递增到 30 秒，够熬过换网、VPN 重连；「无限重试」这个选项还在。顺带修了规范化时缺 strategy 一律落成 `fixed`、不看这一类自己默认的问题——不修的话新的递增默认会被悄悄改回每 5 秒。保存过设置的用户盘上还是旧默认，这次不迁移。
- **手里已经有数据的图表交给界面块。** 「总结一下会话数量，给我个图表看看」这种不需要脚本的图表，模型直接去读 `plume://preview` 写了一页 HTML。preview 的工具说明和界面块那段提示词都写着自己负责 "a chart"，而工具说明长得多，两边都认领时总是它赢。现在 preview 的例子里没有图表了，并指向 ```ui；图示、可交互的表、小游戏、布局稿照旧走 preview。
- **模型弹窗里少了三行。**「关闭思考」（推理强度里已经有「关」）、「管理供应商与模型」，以及「设为新会话的默认模型」——默认模型在设置页的模型里设，首页未开会话时选的本来就是默认。

### 修复

- **把文件存到项目外会弹审批，而不是先拒了再被 shell 偷偷写过去。** `write` / `edit` 对工作区外一律报 `Path escapes the workspace root`，而 `bash` 写到项目外只是 `write-outside-project` 风险、点一下就过。用户说「存到桌面上」时，模型被拒后转身用 `cat > … <<EOF` 写了过去：这道门什么都没挡住，只把写入从「卡片上有 diff、先读后写、留改动记录」的那条路推到了什么都没有的路上。现在工作区外交给工具本来就会发起的审批——ask 每次问，auto 判成 write-outside-project 而问，full 不问，和 bash 一致。仍然拒绝的两处：`~/.plume` 里除 scratch 之外的地方（设置、凭据、技能在那儿，能写就能改掉自己的权限），以及工作区里指向外面的符号链接（卡片按字面路径显示，借链接写出去时卡上只有链接的名字，报错里现在给出真实路径）。
- **别的会话插进来的信，也让主代理不再干等子代理。** 从前只有人插话会让它放手先读消息，而另一个会话用 `steer` 插进来的信是运行时写的，于是一直压到子代理全部交差才被读到——本机实测长轮里等一次子代理平均七分多钟，而发信那一方往往正卡在 `wait_for_session` 上一起等。现在人说的话和别会话插进来的信是一条判断；后台结果的送达仍然不算（放掉一个跑完的子代理，会把其余还在等的也一并放掉），排队等这一轮做完再看的那种信也不算。
- **文件面板里的音视频能拖进度条了。** 所有文件都走 `net.fetch(file://)`、回 200 和整个文件，而拿不到 Range 响应时 Chromium 就认定这个源不能跳：`seekable` 是 [0, 0]，拖进度条或设 `currentTime` 都落回第一帧。音视频现在按 Range 回 206，带 `Content-Range`、`Accept-Ranges`，越界回 416；其余文件仍走原来那条路。
- **内置浏览器开页不再报「面板没就绪」，网页崩溃也不再带走整个应用。** 站点 30 秒不回第一个响应，开页就报「浏览器面板没有在 30 秒内就绪」——面板要等 dom-ready 才向主进程报到；现在 did-attach 就报到，agent 要等的「文档就绪」另算，最多 30 秒，超时就说站点打不开、标签留着。网页进程崩溃会让 Plume 主进程段错误退出（已发布版本就有，杀掉页面进程即可复现）：崩溃后面板插了一行错误把页面挤矮，随后又对一个已经不存在的 guest 调设备仿真。缩放与视口改由 `applyView` 落到页面上、跳过崩溃的；第一次崩溃自动重新加载，15 秒内再崩就停在错误上等人。加载失败和崩溃改成盖在页面区域上的一层，写原因、带重新加载，不再挤动页面，换页后红字也跟着清掉。
- **agent 操作网页不再为没人应答的对话框付时间。** 页面的 `alert`、`confirm`、离开提示会让每一步等满 15 秒、开新页等满 30 秒，因为渲染层应答不了 Electron 弹的系统对话框；现在 agent 调用期间由主进程那一侧应答，并把结果写进返回值。`read` 的元素一行一个、带 ref，编号按标签接续，旧页的 ref 只报失效不会点错；点击前确认目标可见、未禁用、不在动、没被遮挡，最多等 3 秒，被挡住时说清是谁挡的。新增 `back`、`forward`、`reload`、`wait`（跨跳转等文字、元素或表达式），点链接不再每次白等 15 秒。`browser_open` 打不开站点时报出原因，不再交回一页空白错误。
- **地址栏里打了没回车的路径，「在外部浏览器中打开」也能打开。** 那颗按钮原来只认标签上已经打开的那一页：空白标签上贴一条 `~/Desktop/…html` 不回车，它是灰的；而按下按钮那一刻输入框先失焦，失焦又把地址还原成页面的，空白标签上就是清空。现在有打字就交出去回车会打开的那一个，没打字才是屏幕上那一页，按钮按下也不再夺走输入框的焦点。地址照旧在主进程过一遍：网页地址交给系统，本地路径展开 `~` 后只开 `.html`。
- **跨会话消息那一行不再整段加粗。** 过程行的标题统一是 `font-medium`，别的行标题是「思考」这种两三个字的词，加粗读作标签；这一行标题装的是「来自 + 会话名」，整段加粗成了一行粗字，比摘要还抢眼，改回常规字重。「打开这个会话」原来挂在展开后正文的最底下，要先把整封信读完才找得到，现在挪到这一行末尾，做成常驻的图标按钮，悬停提示原文案。
- **GLM 模型显示智谱的 Z，不再是一个中性方块。** 品牌识别表里没有智谱，`opencode-go/glm-5.3-flash` 这类 id 匹配不到任何一家，只能画占位方块。标志取自 z.ai 的 favicon（bigmodel.cn 用的是同一个 Z），去掉原图的深色圆角底板，按单色标志处理，和 OpenAI 一样。
- **减弱动效时，界面块不再在写完之前就能点。** 它那个「正在写」的状态挂在 `fade` 上，而减弱动效时 `fade` 不会亮。

</details>

## [0.9.29](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.29) - 2026-10-13

<!-- plume:notes en -->

### New

- **A gallery of every picture you have drawn, from every conversation.** It sits in the sidebar under Plugins. Pictures are laid out like an album — grouped by day (Today, Yesterday, then the date), newest first, each one at its own aspect ratio rather than cropped into a square. Hovering brings up what you asked for and which conversation it came from, and a picture that took several steps wears a "3 steps" chip in its corner. The search box looks through what you asked, the prompts the model wrote and conversation titles. Clicking one opens it over the gallery, ← → move through the rest, Esc closes; the conversation's title takes you back to that conversation, and "Show in conversation" jumps to the picture where it sits in the transcript, opening the conversation first if it wasn't open.
- **How each picture was made.** Next to the picture is the chain that led to it, one thumbnail per step, top to bottom, each step labelled with what you said at the time plus "Drawn" or "Edited" and when. A picture you attached yourself says so; a copy you marked up says so; a step that can no longer be traced back says "original not found" rather than guessing. Clicking any step switches to that picture.
- **Change a picture without going back to find it.** Under the picture there is a pencil to annotate it, a box to say what should change, and the same send button the composer uses: Enter sends that picture back into the conversation it came from, attached as it is, so the new one is linked to the old. Marks without a word don't send anything — they open that conversation with the marked copy in the composer and wait for you to say what should change. When the new picture lands, the gallery settles on it (it waits up to ten minutes, and won't pull you away if you've moved on to another picture).
- **Projects close on hover.** Hovering the project chip next to the composer brings out a ✕ on its right; clicking it leaves the project without opening the switch-project menu first. The highlight stays on the whole chip while the pointer moves over to the ✕, and in a split view it focuses that pane and leaves the other one's conversation and draft alone.

### Changes

- The title bar keeps side chat, terminal and diff; the browser moved into the "⋮" panel menu with the other panels. Its shortcut is unchanged.
- After 20 requests without a word to you, the automatic nudge no longer asks the agent what it has finished — that asked for a conclusion before the evidence was in, and one was wrong. It now asks what it's doing and what's next, and says not to state unverified findings as fact.

### Fixes

- **A refusal written as an answer is no longer retried every 5 seconds.** When a provider refuses a request, some relays deliver the refusal as ordinary reply text ("The prompt could not be submitted … Generative AI Prohibited Use policy") and then a generic in-stream error; Plume read only the error, called it a server fault, said "server error, retrying in a few seconds" and resent every five seconds, streaming the same refusal again, until you stopped it by hand. The refusal is now recognised — a short piece of visible text (under 600 characters) matching what providers actually write when they refuse — and the turn ends saying it was refused under the content policy, with the request not worth sending again unchanged. For image models on the chat route the card says the same thing. A long answer that merely mentions safety still retries as before.
- **An MCP tool whose array parameter has no element type no longer breaks every turn.** `{"type": "array"}` is legal JSON Schema and common in MCP servers, but relays that send the tool list as protobuf reject the whole request over it ("parameters.properties[machineIds].items: missing field"), so every turn failed for old and new conversations alike, and there was nothing to connect it to the MCP server you had installed. Arrays without an element type are now filled in as accepting anything, which changes nothing for providers that took the bare array.
- **Closing a browser tab no longer raises "browser tab closed".** Clicking ✕ while a page was still loading, or refreshing just as the agent closed the tab, surfaced the internal timing error with its `Error invoking remote method` prefix. The panel just puts that cell away now; the agent's own browser tool still learns its tab is gone.
- **`edit` works on `scratch://` addresses.** It used to read `scratch://x` as the relative path `<project>/scratch:/x`, so the read-before-edit record never matched and every edit to a temporary file was refused with "read it first" — and rereading it, as the error suggested, didn't help; one session spent four rounds going around this. Read, write and edit now resolve the same address to the same file on disk.
- **The plan mode switch doesn't shift its icon 2px.** Off and on were two different buttons — 6px from the left edge and 8px — so toggling rebuilt it and the icon jumped sideways, with the background snapping instead of fading. It's one button in both states now.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **画廊：所有对话里画过的图，收在一处。** 入口在侧栏「插件」下面。图按相册排：按天分组（今天、昨天，再往前是月日和星期），最新的在最上面，每张按自己的原始比例排而不是裁成方块。指上去浮出你当时说的那句话和它来自哪个对话，要经过好几步才画成的图，角上有一枚「3 步」的胶囊。顶上的搜索框会翻你说过的话、模型写的提示词和会话标题。点开一张就盖在画廊上，← → 翻下一张，Esc 关掉；右边的会话标题点一下回到那个对话，「在对话中查看」跳到转录里那张图的位置，对话没开着就先打开它。
- **每张图是怎么来的。** 图旁边是它的生成链路，一步一张缩略图，从上到下，每一步写的是你当时说的那句话，配「生成」或「修改」和当时的时间。你自己附进去的图、在图上标注过的副本都标出来是哪一步；倒推不出来的那一步写「原图找不到了」，不猜。点链路里任意一步就切到那张图。
- **改图不用再回对话里把图翻出来。** 图下面一条编辑栏：左边一支笔用来在图上标注，中间写想怎么改，右边是和对话里同一颗发送按钮——回车就把这张图带着发回它所在的对话，字节原样回去，所以新图和原图连着。只标注、没写字时不自动发，而是打开那个对话、把标注图放进输入框，等你说要改什么。新图画好之后画廊自己停到那张上（最多等十分钟，你已经翻到别的图就不会被拉走）。
- **悬停就能关掉项目。** 输入框旁边的项目芯片指上去，右边浮出一颗 ✕，点它直接不在这个项目里工作，不用先打开「切换项目」菜单。鼠标从名称移到 ✕ 上的过程中整块高亮不消失；分屏里点它会先聚焦那一屏，另一屏的会话和草稿都不动。

### 变化

- 标题栏常驻的只剩侧聊、终端和 diff，浏览器按钮并进「⋮」面板菜单里和其他面板一起。快捷键照旧。
- 连续 20 次请求没对你说过话时的自动提示，不再要它讲「做完了什么」——那是在证据没齐时要阶段性结论，出过错。现在只问在做什么、下一步做什么，并明说没核实的发现别说成定论。

### 修复

- **被拒不再每 5 秒重试一次。** 服务商拒绝某个请求时，有的中转让这段拒绝从回答正文里流出来（`The prompt could not be submitted … Generative AI Prohibited Use policy`），随后再补一个泛泛的流内错误；Plume 只认了那个错误，判成服务端故障，界面上写「服务端故障，几秒后重试」，每 5 秒把同一段拒绝再流一遍，直到手动按停。现在认得出这是被拒：只有一小段可见文字（600 字符以内）命中服务商真在用的拒绝句式才算，这一轮到此为止，并写明是按内容策略被拒、原样再发还是会被拒。生图走对话接口时卡片上也这么写。长回答里顺口提到 safety 的情况和以前一样照常重试。
- **MCP 工具的数组参数没写元素类型，不再让每一轮都失败。** `{"type": "array"}` 是合法的 JSON Schema，MCP 服务器里很常见，但把工具列表按 protobuf 发出去的中转会因此拒掉整个请求（`parameters.properties[machineIds].items: missing field`），新旧会话一律失败，而且人不会把它和自己装的那台 MCP 服务器联系起来。现在这种数组按「元素任意」补全，本来就接受裸数组的服务商不受影响。
- **关掉网页标签后不再弹「浏览器标签已关闭」。** 页面还在加载时点 ✕，或者 agent 刚关掉标签、人正好在刷新，会把主进程内部这个时间差连 `Error invoking remote method` 前缀一起弹成报错。现在面板把那一格收掉就算了；agent 自己的浏览器工具照样知道标签没了。
- **`edit` 能直接改 `scratch://` 里的文件。** 以前它把 `scratch://x` 当成相对路径读成 `<项目>/scratch:/x`，「先读再改」的记录永远对不上，每次编辑临时文件都报「先读再改」，照着报错重读一遍也没用——有一个会话为此多花了 4 轮。read、write、edit 现在把同一个地址解析到磁盘上同一个文件。
- **点计划模式开关，图标不再横移 2px。** 关着和开着原本是两颗不同的按钮，离左沿分别是 6px 和 8px，一点开关就重建元素、图标跟着横跳，背景也跟着硬切而不是渐变。现在两种状态是同一颗按钮。

</details>

## [0.9.28](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.28) - 2026-10-13

<!-- plume:notes en -->

### New

- **The image tool works the way upstream's does**, under the name `image_generate`. It calls the provider's Images API first and falls back to the chat endpoint when that provider has none, remembering which one it is. Aspect ratio, quality, count and background are translated into each family's own spelling by Plume — the model used to guess, and relays that only draw through the chat endpoint didn't work at all.
- **Changing a picture** uses `#1`, `#2` to name the ones in the conversation, newest first. Each picture gets three attempts; a spent quota or a key that isn't allowed that model is not retried — the card says which, and about when the quota comes back.
- **Image models are their own kind.** Turn on "Image model" for a provider's model in Models: conversation pickers no longer offer them (picking gpt-image-1 there failed every turn), and an image model's "Test by drawing one small picture" really draws one, billed.
- **The card in the conversation** holds the shape it will fill while the picture is drawn, with the stage on its top line and an estimate in the corner, "Connection hiccup — retrying" when it retries, a picture that goes from blurred to sharp without the frame moving, and the model and size once it's done. Hovering gives Edit and Download.
- **Viewing a picture:** the zoom no longer starts as a 0.4 ghost with the backdrop black on its first frame, and the annotation canvas sits over the picture instead of replacing it, so Edit goes straight into annotating. Annotating a picture in the conversation and pressing Done puts the annotated copy into that conversation's composer.
- **The fetch-models dialog removes as well as adds.** Models you have are checked, ones the endpoint didn't list are marked as such, unchecking removes, and typing an id and pressing Enter adds one it didn't list. The model list can delete several at once; before it was one at a time, each with its own confirmation.
- **Long pages are checked in parts.** When a page is taller than 2160px, the result says where the next part starts, and passing that back photographs that part. The model used to split the page into p1~p5.html and check each one — a dozen extra calls for one landing page. The result also always says which width it was checked at.
- **The thinking row counts seconds.** While it runs it shows how long this stretch has been going (from the start of this thinking, not of the turn) beside the word, and the word changes as the thinking gets longer, dropping into place while the seconds after it slide over rather than jump.
- **Edits replace the text you can see again.** Changing one word no longer means retyping the whole line; where one line is a thousand characters (LaTeX, a Markdown paragraph), models wrote a script to batch the change rather than edit the file. The model now gives the passage and what it becomes, with the same safety as before: the file was read, hasn't changed since, and the passage is unique in it. A passage that doesn't match gets the familiar deviations tried first — curly quotes, a line-number prefix, escaping — and the edit goes through only when one reading fits.

### Cheaper

- The preview tool's 5,300-character description no longer rides along with every request. Ten of 142 real conversations used it, and none of the 27 pages used the page API; the page API is read from `plume://preview` and the interface-block syntax from `plume://ui`, both just before they are needed.
- A web page cut off by `web_fetch` goes into the conversation's scratch directory, with the path and the full length in the result. A 130,000-character source file arrived as its first 35,000, and the model downloaded it again with bash.

### Changes

- The agent verifies before handing something over — runs the tests, runs the build, pastes a failure as it came — instead of stopping at types that line up.
- Describing a problem or asking a question gets you a judgement, not an edit; asking for a change gets the change rather than a plan.
- Changes in your project that the agent didn't make are treated as yours: unrelated ones are left alone, related ones are built on, and neither is thrown away with checkout, reset or stash.

### Fixes

- **Relays and gateways.** Mistral's array content no longer becomes `[object Object]`; OpenRouter's in-stream errors are no longer swallowed as "upstream failed", so an exhausted quota and an over-long context are recognised; TGI's and Mistral's `finish_reason` aliases no longer throw away a whole good answer and retry; Kimi's usage under `choices[0]` is read, so the cost isn't recorded as 0; MiniMax's resent reasoning snapshot no longer adds a second thinking block; tool arguments that arrive again or split across objects no longer lose keys; a host that doesn't close the connection after `finish_reason` no longer makes Plume wait out the idle gate and resend an answer it already had.
- **How failures are classified.** A 200 that isn't SSE (an error written as JSON, a URL pointing at a web page, one non-streaming JSON body), an error frame with no `error`, and reasoning that used up the output limit all used to land as "empty answer", be resent four times, and have the original thrown away. A certificate error now looks at the innermost cause, a 407 from a proxy no longer counts as a dropped connection to retry forever, and a server's stated wait is honoured up to five minutes instead of one.
- **Thinking is turned off the way each vendor documents it.** Gemini and the o-series reject "off", newer Claude wants adaptive, DeepSeek and GLM-5.2+ take `output_config.effort` instead of `budget_tokens`, and GLM-5.3 and Kimi K3 can't turn thinking off at all, so the setting no longer offers it. These rules were spread across three adapters, which is how turning thinking off on Gemini failed on the chat link entirely.
- **Stopping a turn on Responses no longer wrecks the conversation.** A reasoning item gets its id when it starts but its encrypted content only when it finishes; stopping mid-reasoning replayed an item with just an id, the server couldn't find it, and every turn after that failed. An unfinished reasoning item from an interrupted or failed turn is no longer replayed.
- **One rejected signature no longer turns off Anthropic reasoning replay for the whole process.** The downgrade was written to a process-wide table and never undone when a retry succeeded, so a problem in one conversation's own history left every conversation on that model without replayed thinking blocks until a restart. It now applies to that one retry, and, once that works, to that conversation.
- **Errors raised before the request goes out are not retried forever.** A zero-width character in a key, https against a local server that only speaks http, an untrusted certificate — all of these were classified as network errors, and network errors retry without limit, so the window just said "Connection dropped" and kept reconnecting. They now end the turn and say what happened.
- **A long reasoning stream is no longer cut off at five minutes.** The idle gate says ten minutes, but Node's built-in fetch cuts the body after 300 seconds with no bytes, so a legal five-minute silence was treated as a dropped connection and resent from the start, billed again. The clock now resets on bytes that arrive.
- A call to a tool that takes no arguments, with its arguments written as `null`, is no longer refused as unfinished JSON: `null` is complete, legal JSON and means the same as `{}`.
- **A batch of interface problems fixed upstream after the v0.9.22 fork**, which this code has too: overlays and dialogs that vanished without playing their exit when a button or the caller dismissed them; a dialog that jumped back to full opacity before fading when Esc was pressed during its entrance; the projects menu landing on the button for a frame when there are many projects; a sidebar title flashing back to the old one when it is rewritten twice in a row; the screenshot magnifier appearing as an empty black box the first time; the "running" row disappearing in a single frame when a turn ends with no text (tools only, stopped, or an error); a picture dropped into the composer being deleted by the next keystroke and the attachment tray vanishing for a frame; Done on a picture annotated inside a sent message doing nothing, because the canvas was tainted by `ly-media://` and the failed export was silent; and a preview card stuck at 440px while the machine was busy.
- Two high-severity dependency advisories cleared: undici to 7.30.0 and linkify-it to 5.0.2.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **画图的工具改成上游的做法**，名字也改成 `image_generate`。先请求服务商的 Images 接口，这家没有这个接口时改走对话接口出图，并记住它属于哪种。比例、清晰度、张数、背景由 Plume 按模型家族换算成各家的写法——以前模型得自己猜，只能经对话接口出图的中转干脆用不了。
- **改图时用 `#1`、`#2` 指对话里的图**，按新到旧数。每张最多试 3 次；额度用完、密钥没开这个模型就不重试，卡片上直接写是哪种，以及额度大约什么时候恢复。
- **生图模型单算一类。** 在「模型设置」里给供应商的模型打开「生图模型」：对话模型的列表里不再出现它们（以前在那里选中 gpt-image-1，每一轮都失败），生图模型自己的「画一张小图测试」是真画一张，会计费。
- **对话里的卡片**按要的比例先把地方占住，上面一行写进行到哪一步，角上是估计的进度；重试时写「连接不稳，正在重试」；图到了从模糊变清晰、框不动；画完写用的是哪个模型、多大尺寸，指上去有「编辑」和「下载」。
- **看图**：放大不再从 0.4 的淡影起步、遮罩第一帧也不再全黑；标注画布叠在图上而不是替换它，从「编辑」直接进标注。对话里的图标注完按「完成」，带标注的副本进这一屏的输入框。
- **拉取模型的弹窗现在能删也能加。** 已经添加的默认勾着，这次端点没列出的标出来，取消勾选就是移除，敲一个模型名回车能加一个没列出的。模型列表可以勾选后一次删掉多个，以前只能一个一个删、每个确认一次。
- **长页面分几段检查。** 页面比 2160px 高时，结果会给出下一段的起点，带上它再检查一次就截那一段。以前模型只能自己把页面切成 p1~p5.html 逐个检查，一个宣传页多花十几次调用。结果也总会写明按多宽检查。
- **思考行会走秒。** 运行中的思考行除了那个词，还写这一段已经想了多久（从这一段思考开始算，不是整轮），词也随想的时间往下换；换词时新词落入，后面的秒数被推过去而不是跳。
- **改文件改回按原文替换。** 改一个词不用再把整行原样重打——一段一行的文本（LaTeX、Markdown 段落）一行上千字，模型宁可写脚本批量套改动也不直接改文件。现在它给出一段原文和要替换成什么，安全照旧：那个文件读过、读完之后没有被改过、原文在文件里唯一。原文对不上时先试弯引号、行号前缀、转义这些常见偏差，只有一种解释对得上才替换。

### 更省

- preview 那 5,300 字符的工具说明不再跟着每次请求走。142 个真实会话里只有 10 个用到它，27 个页面没有一个用过页面里那组接口；现在页面接口从 `plume://preview` 读、界面块的写法从 `plume://ui` 读，都在要用之前才读。
- `web_fetch` 截断的正文存进会话的临时目录，结果里给出路径和完整长度。一份 13 万字的源码以前只给前 3.5 万，模型只好用 bash 再下一遍。

### 变化

- agent 交东西之前会先跑起来验证：跑测试、跑构建，失败贴原文，不再停在类型对得上。
- 你在描述问题、问它问题的时候，它给的是判断，不会顺手改；要它改的时候也不停在方案上。
- 项目里不是你做的改动，它当成你的：无关的不碰，有关的接着改，不用 checkout、reset、stash 丢掉。

### 修复

- **中转和网关。** Mistral 把 content 写成数组时不再变成 `[object Object]`；OpenRouter 的流内错误不再被吞成「上游失败」，额度不足和上下文超长都认得出；TGI、Mistral 的 `finish_reason` 别名不再把整段回答作废重试；Kimi 放在 `choices[0]` 里的 usage 读得到，花费不再记成 0；MiniMax 重发的推理快照不再多出一个思考块；工具参数被重发或按对象分片时不再丢键；收到 `finish_reason` 之后不关连接的宿主，不再让 Plume 干等满空闲闸、把已经答好的回答丢掉重发。
- **失败怎么分类。** 200 却不是 SSE 的（错误写成 JSON、地址指到了网页、整份非流式 JSON）、不写 `error` 的错误帧、推理把输出上限用完的空回答，从前都落成「空回答」、重发四次、原文丢掉。证书不受信任现在看 cause 链最里层，代理的 407 不再当断线无限重试，服务端给的等待时间最多认到 5 分钟而不是 1 分钟。
- **思考按各家文档的写法关。** Gemini 和 o 系列拒绝「关闭」，新 Claude 要 adaptive，DeepSeek 与 GLM-5.2+ 改发 `output_config.effort` 而不是 `budget_tokens`，GLM-5.3 和 Kimi K3 根本关不掉，所以界面上不再给这一档。这些判断原来散在三个适配器里，Gemini 上关思考在对话链上全挂就是这么来的。
- **在 Responses 上按停止，会话不再报废。** 推理块的 id 在项开始时就有了、密文要到结束才有；推理到一半按停止，下一轮会回放一个只有 id 的推理项，服务端找不到它，之后每一轮都失败。中断或出错那一轮没写完的推理块现在不回放。
- **一次签名被拒，不再让整个进程关掉 Anthropic 的思考回放。** 降级原来写进进程级的表，重发成功了也不撤销，于是一个会话自己历史里的问题，让同模型的所有会话都不再回放思考块，直到重启。现在降级只用于这次重发，成功了记在这个会话上。
- **请求发出之前就失败的错误不再无限重连。** 密钥里混进零宽字符、用 https 连了只开 http 的本地服务、证书不受信任——这些在请求发出前就抛的错误从前一律判成网络问题，而网络问题不限次数重试，界面上只看见「连接中断」一直转。现在判终局，并说明是怎么回事。
- **长推理流不再五分钟被切断。** 空闲闸写的是十分钟，但 Node 内置的 fetch 默认 300 秒没有字节就切断响应体，一条合法沉默五分钟的推理流会被当成断线、从头重发、重新计费。空闲计时改成按收到的字节重置。
- 不带参数的工具，参数被写成 `null` 时不再当成没写完的 JSON 拒绝：`null` 是完整合法的 JSON，意思和 `{}` 一样。
- **一批上游在 v0.9.22 分叉之后修过、我们也有同样毛病的界面问题**：浮层和对话框点按钮或由调用方关掉时直接消失，不播退场；对话框入场途中按 Esc，会先跳回不透明再淡；项目多的时候「项目」菜单打开的第一帧盖在按钮上；侧栏标题连着改两次会先闪回旧标题；截图放大镜第一次出现是一个空的黑框；一轮没有正文就结束（只调了工具、被停、出错）时「运行中」那一行一帧就没了；递到输入框里的图一打字就被删、附件托盘收起时一帧消失；已发消息里的图标注完按「完成」没反应，因为画布被 `ly-media://` 污染、导出失败又没出声；预览卡片在机器忙的时候锁死在 440px。
- 依赖里两条 high 清掉：undici 升到 7.30.0，linkify-it 升到 5.0.2。

</details>

## [0.9.27](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.27) - 2026-10-12

<!-- plume:notes en -->

### New

- **Plan mode.** Turn it on with `/plan` or the "Plan mode" chip on the input box. The agent then only reads and investigates: edits are refused, and shell commands are limited to read-only ones in a read-only sandbox. It hands you a plan as an approval card; once you approve it, the plan becomes the task list and stays there through compaction. You can switch it on in a new conversation before sending anything, so the first message doesn't run as a normal turn first.
- **Select text in a reply to ask about it.** A small menu appears above the selection: "Ask in side chat" or "Quote in message". Quotes sit above the input box as "2 quotes" instead of filling it with `> …` lines; hover to read them and remove them one at a time. `/btw <question>` asks in a new side chat and leaves nothing in the main conversation.
- **Side chat can edit files and run commands.** It is now a conversation attached to the main one, with its own short prompt and 13 tools. Before each question it is told what's new in the main conversation, and when it changes files, the main conversation hears about it at the start of its next turn. Side chats saved in `~/.plume/sidechats` by earlier versions are not carried over.
- **An Environment card in the title bar** collects what used to be scattered: how the conversation is opened, background jobs, subagents, the pull request for this branch, side chats, a running summary, and the images and files that came into the conversation. Each row opens the panel or viewer that already exists. In wide windows the conversation moves 324px to the left so the card doesn't cover it. The summary model is set under Settings › Subagents and follows the conversation's model by default.
- **Pages the agent makes can be copied as an image**, as you left them after clicking around. The whole page is copied, including the part folded below 720px or scrolled out of view.
- **Those pages remember what you set.** Values you change with a page's controls are kept when you reopen the conversation, and the model gets them with your next message. Design pages can offer sliders, colors, switches and menus under "Adjust design": dragging updates the page without asking the model, and "Apply these settings" sends only the values you changed.
- **The thinking row says "Thought for 12s"** instead of printing the reasoning word by word. While it runs it shows one label such as "Brainstorming". Under a second, or when a relay sends all the reasoning at once, it says "Thought for a while".
- **Switching models draws a line in the conversation** saying which model it switched from and to. It goes by which model actually answered, so changing the menu without sending anything leaves no line. Older conversations show it too.
- **The conversation hover card leads with what it cost**: main conversation, subagents and side chats added together, "Unpriced" when the model has no price instead of $0. A second row splits the tokens between those three. Side chats and subagent panels now have their own context meter.
- **Files can be dropped anywhere on the conversation**, not only on the input box. A dropped folder becomes an attachment chip instead of a long `@"/var/folders/…"` path, and chips use the file tree's icons for each file type.
- **MCP servers that need a sign-in can connect**, such as the official GitHub, Linear and Notion servers; Plume handles the OAuth flow and keeps the tokens in its vault. Server prompts show up in the `/` menu, and a server can ask you to fill in a form partway through a task.
- **Many MCP servers no longer crowd the context.** When their tool descriptions add up to more than 3,000 tokens, the model gets a catalog and two tools to search and call them. With 30 servers, that is 9.8k tokens instead of 38.7k. A server that hangs no longer holds up the conversation for 32 seconds; the first turn waits at most 5.
- **`lsp` works for Python, Go, Rust and C/C++** when basedpyright or pyright, gopls, rust-analyzer or clangd is on your PATH. If the server isn't installed, the result says which one to install instead of quietly falling back to text search.
- **ripgrep comes with the installer.** Started from the Dock or the Start menu, Plume couldn't see your own `rg`, and every search used the slow fallback: 1,789ms against 46ms on this repository.
- **Questions about Plume itself are answered from its own help.** "How do I add an MCP server", or a pasted error message, is answered from 21 bundled pages on commands, settings, permissions, extensions and common errors. Before, the model searched through the app's files.
- **Two new hook events: `StopFailure` and `SessionEnd`.** `StopFailure` runs when a turn ends with an error, is stopped, or hits a limit; `SessionEnd` when a conversation is deleted, archived, moved or the app quits. Dashboards like Vibe Island no longer show a session as working forever.
- Hooks run inside a subagent show up in that subagent's panel, and hook input now includes `agent_id`, so two subagents of the same type can be told apart.
- After 20 requests without reporting back, the model is asked where things stand: the task list is read back to it if there is one, otherwise it is asked for a sentence or two. It is never stopped for this. In 367 past runs, 301 finished within 20 requests and would never have been asked.
- Magpie can manage Plume's models; new conversations go through its gateway.

### Cheaper

- **A new conversation starts 24% lighter.** Before you type anything, the context meter reads 10.6k instead of 14.1k, with the same tools.
- **Compaction reads from the cache.** The summary request is the previous request sent again with one instruction added, so the conversation before it costs cache price instead of full price. If a turn ends past the line, compaction runs right away while the cache is still warm; anything you send in the meantime goes out after it.
- After an edit, the result shows the changed lines with their new line numbers. In past conversations, 71 of 154 edits were followed by reading the same file again.
- Files under 300 lines are read in full instead of being folded into an outline, which the model then read back piece by piece. The symbol index now covers the whole project; on this repository it used to stop halfway.
- Checking a background job that has no new output waits up to 30 seconds for output or for the job to end. Before, 39 of 47 checks came back with "(no new output)", each one a full request.
- Web pages and MCP results close to 40,000 characters were cut to their first 4k and last 1k before the model saw them. They now arrive whole.

### Changes

- Subagents no longer start subagents of their own; splitting work is left to the main conversation. An extension that blocks a call in the main conversation now blocks the same call in a subagent.

### Fixes

- **In "Auto approve" mode, a `PreToolUse` hook that asks for confirmation now gets it.** The approval policy answered in its place, and the call ran without asking.
- **`git checkout .`, `git restore .`, `git push origin +main`, `--mirror`, `git stash clear` and `git worktree remove --force` ask first.** They used to run without asking. Switching branches and unstaging still don't ask.
- Messages sent from the phone while a task is running wait for the turn to finish instead of cutting into it.
- **Chats outside a project each get their own folder.** They all shared `~/.plume/workspaces/general`, so a new chat could find files from older ones; one took a landing page made in another chat as your design preference. Existing chats keep their folder.
- With "Create a worktree for every new conversation" on and no root set, worktrees were made next to the repository, and staging, committing and pushing in them failed with "not inside an open project". They now go in `~/.plume/worktrees`. Existing worktrees are not moved.
- Settings › Commands was missing `/plan`. Several settings descriptions now say what actually happens: for example, "Ask for approval" said it asks before going online, but web search and web fetch never ask. The hook matcher placeholder reads `Write|Edit|Bash`; the comma-separated version it showed before matched nothing.
- **`glob`, `grep` and the symbol index see the same files git does.** Ignored build output is skipped, a committed folder that happens to be called `build/` is not, and hidden files such as `.github/workflows/package.yml` are found. Without ripgrep, a search across this repository dropped from 1.8s to 0.2s, and matches close together no longer print the same context twice.
- When the macOS sandbox blocks `top` or `sudo`, the model is told the sandbox refused it, not that a file write was denied, so it stops trying other ways to write a file.
- When the model writes an interface block without the ` ```ui ` fence, it shows up as text. The model is now told so on the next turn.
- Checking or stopping a background job shows "Read output" or "Stopped a command", not a job uuid.
- A file name in a reply that matches several files in the project opens a menu of their folders instead of "Cannot read this file".
- A long page title no longer pushes a right-column tab's close button out of view. Titles stop at 160px.
- Going back to a conversation with a panel open no longer moves what you were reading about 270px down.
- The "Chats" heading in the sidebar stays at the top while you scroll through it, like project names do.
- Running conversations in the sidebar show the breathing dot again instead of a column of spinning rings.
- The hover card no longer says "1 steps", or calls 12.3k cached tokens "12.3k cache reads".
- MCP tools meant only for a server's own web page are no longer given to the model.

### Removed

- **The compaction model setting.** A different model can't read the main conversation's cache, so compaction always uses the conversation's own model.
- The switch for building local memory from tool-assisted chat. Nothing ever read it.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **计划模式。** 用 `/plan` 或输入框上的「计划模式」芯片打开。打开后 agent 只读、只调查：改文件会被拒，命令只放只读的，跑在只读沙箱里。调查完交一份计划，以审批卡片的形式给你；批准后计划变成任务清单，压缩之后也还在。新对话还没发第一句话时就能打开，不必先让第一句话按普通模式跑完一轮。
- **对话里划一段文字，可以直接拿去问。** 选区上方出现一枚小菜单：「在侧边聊天中提问」或「引用到输入框」。引文不再以 `> …` 塞满输入框，而是在框上方显示成「2 条对话引用」，指上去看原文，可以逐条删。`/btw 问题` 会新开一格侧边聊天去问，主对话里什么也不留。
- **侧边聊天能改文件、跑命令了。** 它现在是挂在主会话旁边的一段对话，有自己的一份简短提示词和 13 件工具。每次提问前，它会收到主会话里的新进展；它改了文件，主会话下一轮开头会知道。旧版本存在 `~/.plume/sidechats` 里的侧边聊天不迁移。
- **标题栏多了一张「环境」卡片**，把原来散在各处的东西收在一起：会话用什么打开、后台任务、子智能体、这个分支的拉取请求、侧边聊天、会话摘要，以及进过这段对话的图片和文件。每一行都是入口，点了去已有的面板或查看器。窗口够宽时对话整体往左让 324px，卡片不盖字。摘要用的模型在「设置 › 智能体」里选，默认跟随会话模型。
- **agent 做的页面能复制成图片**，复制的是你点过之后的样子，而且是整页：折在 720px 以下的、滚出对话的部分都在。
- **这些页面记得你调过的值。** 用页面上的控件改过的值，重开对话还在，下一句话会一起交给模型。设计稿可以在「调整设计」里放滑块、颜色、开关、下拉：拖一下页面当场变，不经过模型；点「按这组设置修改」，模型只收到改过的那几项。
- **思考行写「思考了 12 秒」**，不再逐字滚动推理。运行中只显示一个说法，比如「头脑风暴中」。不满一秒，或者中转把整段推理一次吐出来时，写「思考了一会儿」。
- **换了模型，对话里会画一条线**，写着从哪个换到哪个。按实际回答的模型来认：只在菜单里换一下、一句没发，不会画线。旧对话也能看到。
- **会话悬停卡片先写这段对话花了多少钱**：主会话、子智能体、侧边聊天加在一起；模型没有单价时写「未定价」，不写 0 美元。第二行把 token 按这三处拆开。侧边聊天和子智能体面板也有了自己的上下文表。
- **文件拖到对话的任何位置都能添加**，不必瞄准输入框。拖进来的文件夹变成一枚附件标记，不再是一长串 `@"/var/folders/…"`；附件标记按文件类型用文件树里的图标。
- **需要登录的 MCP 服务器能连上了**，比如 GitHub、Linear、Notion 的官方 MCP。OAuth 由 Plume 走完，令牌存进它的保险库。服务器带的提示词出现在 `/` 菜单里；服务器也能在任务中途弹一张表单让你填。
- **接很多 MCP 服务器时不再挤占上下文。** 工具说明合计超过 3,000 token 时，模型拿到的是一份目录和两件工具，用来搜索和调用。接 30 台服务器时，这部分从 38.7k 降到 9.8k token。一台服务器卡住不再拖住会话 32 秒，首轮最多等 5 秒。
- **`lsp` 支持 Python、Go、Rust 和 C/C++**，前提是 PATH 上有 basedpyright 或 pyright、gopls、rust-analyzer、clangd。没装语言服务器时，结果会写明要装哪个，不再一声不吭地退回文本搜索。
- **安装包自带 ripgrep。** 从程序坞或开始菜单启动时，Plume 找不到你自己装的 `rg`，每次搜索都走慢的兜底：在本仓库上是 1789ms 对 46ms。
- **问 Plume 自己的事，它查自带的说明。** 「怎么加 MCP 服务器」，或者贴一句界面报错，模型会从随包带的 21 篇说明里找答案，涵盖命令、设置、权限、扩展和常见报错。以前它会去翻应用自己的文件。
- **钩子新增 `StopFailure` 和 `SessionEnd` 两个事件。** 一轮出错、被停下或撞上上限时跑 `StopFailure`；会话被删除、归档、移走或退出应用时跑 `SessionEnd`。Vibe Island 这类看板不会再让一个会话永远停在「工作中」。
- 子智能体里跑的钩子显示在它自己的面板上。钩子输入里多了 `agent_id`，同类型的两个子智能体能分得清。
- 连着 20 次请求都没汇报时，模型会被问一句进度：有任务清单就把清单念给它，没有就让它用一两句话说说现状。只问，不会因此停下。在过去 367 次真实运行里，301 次在 20 次以内就做完了，一次都不会被问。
- Magpie 能接管 Plume 的模型，新会话走它的网关。

### 更省

- **新对话一开始就轻了 24%。** 还没打字时，上下文表从 14.1k 降到 10.6k，工具一件没少。
- **压缩能吃到缓存了。** 写摘要的请求是把上一次请求原样再发一遍、末尾加一句指令，于是前面那一大段按缓存价计，不再按原价重读。一轮结束时已经过线，就趁缓存还热当场压掉；这期间你发的话排在压缩后面发出。
- 改完文件，结果里直接带上改动那几行和新行号。以前的会话里，154 次改动有 71 次紧接着又把同一个文件读一遍。
- 300 行以下的文件整份读出，不再先折叠成结构视图、再被模型一段段读回来。符号索引覆盖整个项目，以前在本仓库上只覆盖到一半。
- 查看一个没有新输出的后台任务时，最多等 30 秒，等到有输出或任务结束再回答。以前 47 次查看里有 39 次拿回的是「(no new output)」，每次都是一整次请求。
- 接近 40,000 字的网页和 MCP 结果，以前在模型看到之前就被剪成前 4k、后 1k，现在完整送到。

### 变化

- 子智能体不再派自己的子智能体，拆活交给主会话。扩展在主会话里拦下的调用，在子智能体里也一样拦得住。

### 修复

- **「帮我批准」模式下，`PreToolUse` 钩子要求确认的调用会先问你。** 以前审批策略替你答了，调用一声不响地跑了。
- **`git checkout .`、`git restore .`、`git push origin +main`、`--mirror`、`git stash clear`、`git worktree remove --force` 会先问一句。** 以前直接执行。切分支、取消暂存照常不问。
- 任务跑着时从手机发的消息，排到这一轮结束之后，不再插进正在跑的那一轮。
- **不在项目里的聊天各用各的目录。** 以前它们共用 `~/.plume/workspaces/general`，新对话会翻到旧对话留下的文件：有一次模型把另一段聊天做的宣传页当成了你的设计偏好。已有的聊天保留原目录。
- 打开「新建会话时自动创建独立工作树」、根目录又留空时，工作树建在了仓库旁边，在里面暂存、提交、推送都报「该目录不在已打开的项目内」。现在放在 `~/.plume/worktrees`。已经建好的不迁移。
- 「设置 › 命令」里漏了 `/plan`。几处设置说明改成和实际一致：比如「请求批准」说访问网络时会问，其实网页搜索和抓取从来不问。钩子匹配器的占位改成 `Write|Edit|Bash`，以前那种逗号分隔的写法什么也匹配不上。
- **`glob`、`grep` 和符号索引看到的文件和 git 一致。** 被忽略的构建产物不再搜，提交进仓库、只是恰好叫 `build/` 的目录不再被跳过，`.github/workflows/package.yml` 这种隐藏文件也搜得到。没有 ripgrep 时，全库搜一次从 1.8 秒降到 0.2 秒；挨得近的命中不再把同一段上下文印两遍。
- macOS 沙箱拦下 `top`、`sudo` 时，模型收到的是「被沙箱拒绝」，不再是「文件写入被拒」，不会再换着法子去写文件。
- 模型写界面块时漏了 ` ```ui ` 围栏，界面上会显示成一段文字；现在下一轮会告诉它。
- 查看或停止后台任务时，活动行写「查看输出」「停止命令」，不再是一串任务 uuid。
- 回复里的文件名在项目里有好几份时，点开会弹一个菜单列出各自的目录，不再弹「读不到」。
- 右栏标签的网页标题太长时，关闭按钮不再被挤出视野。标题截到 160px。
- 切回一个开着面板的会话时，正在读的那一段不再往下跳约 270px。
- 侧栏滚进「聊天」那一节时，「聊天」标题和项目名一样钉在顶上。
- 侧栏里正在跑的会话改回呼吸灯，不再是一列各自转圈的环。
- 英文界面的悬停卡片不再写「1 steps」，也不再把 12.3k 缓存 token 写成「12.3k cache reads」，读起来像读了一万多次缓存。
- 只给 MCP 服务器自己页面用的工具，不再交给模型。

### 移除

- **压缩模型设置。** 换一个模型就读不到主会话的缓存，所以压缩一律用会话自己的模型。
- 「允许基于工具辅助聊天生成本地记忆」开关。从加上起就没有代码读过它。

</details>

## [0.9.26](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.26) - 2026-10-10
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

## [0.9.25](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.25) - 2026-10-09
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

## [0.9.24](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.24) - 2026-10-09
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

## [0.9.23](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.23) - 2026-10-04
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

## [0.9.22](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.22) - 2026-09-29
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
