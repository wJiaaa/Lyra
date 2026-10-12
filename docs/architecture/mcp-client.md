# MCP 客户端：连接、工具、延迟加载、提示词、填表与登录

协议全部交给 `@modelcontextprotocol/sdk`（1.32.1），这里记的是接到产品里时做的几个取舍。
代码在 `packages/core/src/mcp/`。

## 连接（`client.ts`、`stdio.ts`）

- **会话启动不等 MCP。** `AgentSession` 用 `connectAll(..., { wait: 0 })` 在后台连，第一轮开始前
  （`assembleTurn` 里的 `mcpReady()`）最多再等还在第一次连的服务器 5 秒（`MCP_START_GRACE_MS`）。
  30 台正常服务器加一台卡死的，会话开始前的等待从 32 秒降到 5 秒；没赶上的那台连上以后从下一轮
  起可用。命令行（`cli/src/run.ts`）在发任务前等全部连完（`settled()`）：评测要的是同一个任务
  每次看到同一份工具表，不是早几秒开始。
- **重连。** 连着的服务器断了（`client.onclose`）按 500ms 起、翻倍、封顶 30 秒退避重连，最多 8 次；
  连上后稳定 30 秒才把计数清零，免得「一连上就崩」的服务器永远在第 1 次。参数照 deepseek-harness。
  启动就失败的不自动重连——配错了，重试只是刷屏。设置页对失败和正在重连的服务器给「重新连接」，
  手动重连会清零计数、先结束旧进程。
- **stderr。** stdio 服务器的 stderr 走管道，只留最后 20 行（每行 500 字、共 4000 字），名字像密钥
  的环境变量值打码。设置页卡片上展开全文，对话里的通知只带最后一行（那多半就是原因），工具调用
  失败时补在错误后面。
- **Windows 结束整棵树。** `npx`、`.cmd` 会多出一层 `cmd.exe`，SDK 的 `close` 只结束这一层。关闭和
  手动重连都先 `taskkill /PID <pid> /T /F`（`windowsHide`）。
- **状态**：`connecting` / `connected` / `reconnecting`（带第几次）/ `failed` / `needs-login`。
  `onChange` 推给会话；会话对非「需要登录」的失败在对话里发一条 `mcp-failed` 通知，同一个错误只发一次。
  设置页先报会话手上那条连接的状态（几个会话不一致时报有麻烦的那份），没有会话连着才临时探测
  （`electron/mcp-probe.ts` 的 `mcpStatusFor`）：断线重连只发生在会话的连接上，探测看不见。

## 工具（`names.ts`、`tool.ts`、`result.ts`）

- **名字。** 三家协议（Anthropic、OpenAI Chat / Responses）都要 `^[a-zA-Z0-9_-]{1,64}$`，Gemini
  还要字母或 `_` 开头，`mcp__` 前缀满足。名字清洗有损、超过 64 或撞了别的名字时，换成截短加
  `serverId\0toolName` 的 8 位 sha256：同一台服务器的同一个工具永远得到同一个名字，和列表顺序、
  另外哪些服务器在线无关。跨服务器撞名、撞内置工具时**撞的每一方**都换哈希名，不按谁先到分大小。
- **工具表什么时候变。** 工具表在提示缓存前缀的最前面（ADR-0025），每一轮在 `assembleTurn` 里读一次。
  服务器连上、断开、`notifications/tools/list_changed` 都只改「下一轮的工具表」，正在跑的这一轮不动：
  一轮之内的几次请求共用前缀，中途换表会让剩下的每次请求都整段重算，模型还会看到上一条消息里
  调过、这一条里却不存在的工具。断线重连回来的工具表没变时不算变化，前缀照旧命中。
  列表翻页（最多 50 页）；SDK 的 `autoRefresh` 只取第一页，所以关掉它自己重列，重列失败保留旧表。
  resources 每次调用现取，不缓存，不需要处理它的 `list_changed`。
  工具多到延迟加载以后，工具表里只剩两个固定入口，上面这些变化都不再碰工具表，见下一节。
- **超时、取消、进度。** 超时按「多久没动静」算：5 分钟内既没有结果也没有进度就取消，有进度就
  重新计时（`resetTimeoutOnProgress`），不设总时长上限——报着进度的调用在干活，要它停的是人。
  人按停止和超时都由 SDK 发 `notifications/cancelled`。进度每 200ms 最多推一次到工具卡片。
- **结果预算。** 和 `bash`、`web_fetch` 一样压在循环的首发剪枝线（`FRESH_RESULT_MAX_CHARS`）以内：
  超过 `FRESH_RESULT_MAX_CHARS − 2000` 的文本在 `result.ts` 按头 80% 尾 20% 截好，模型看到的就是这
  三万多字，不会再被循环剪成头 4096、尾 1024；全文写进草稿目录的 `mcp-results/`，说明里给出路径，
  要中间那段自己 `read`。没有草稿目录（设置页探测）时只请它换个窄一点的问法。
  图片超过 200 KiB 不内联：原图进会话媒体（卡片上照样显示），另存一份到草稿目录的 `mcp-images/`，
  模型拿到路径，要看再 `read`；超过 5MB 的不存。音频只留一句说明。
- **结构化结果与资源。** `structuredContent` 在文本块里没有同样内容时以 JSON 附上（规范只要求
  「SHOULD」同时给文本，不给的服务器会让模型看到一个空结果）；声明了 `outputSchema` 却不合格的，
  SDK 抛错，按调用失败处理。嵌入的文本资源带着 URI 原样给出，图片 blob 当图片，其他 blob 只描述；
  `resource_link` 变成一行带名字、类型、大小的说明，告诉模型用 `read mcp://<服务器>/<uri>` 读。
- **注解只往谨慎的方向起作用。** 规范明说注解不可信。`destructiveHint` 让审批策略判成有风险
  （`mcp-destructive`）；`readOnlyHint` 单凭它不免审批，只有人在设置里打开这台服务器的「信任只读
  声明」（`trustReadOnly`）后，才在 `auto` 模式下免掉逐次确认；两者同时声明按破坏算。
  `openWorldHint` 不参与判定：默认就是 true，拿它加审批等于给每个工具加。只读还决定能否并行执行。

## 延迟加载

MCP 工具多了以后不进工具表，模型经 `mcp_search` / `mcp_call` 找到、调用。机制、前缀怎么保持
不变、为什么不用服务商的原生工具搜索、内置工具为什么不这样做，见 [工具延迟加载](mcp-search.md)；
这里只记 MCP 特有的部分。

**为什么。** 2026-10-11 在本机真实会话上量（`toolTokens` 的 3.5 字符估，Anthropic 编码）：内置工具
约 6–7.4k token，已经占中位首轮请求（14.3k）的一半；照真实服务器写的 30 台、247 个工具
（`core/test/mcp-catalog-fixture.ts`）是 31.3k，接上以后首轮请求约 45.6k，MCP schema 占 68.6%。
单台服务器中位 873 token、最多 2.6k。而且这一段在缓存前缀最前面：哪台服务器连上、断开、
`list_changed`，整段前缀从工具表起重算。

**MCP 特有的几条：**

- **有阈值。** MCP 工具 schema 合计超过 `DEFER_MCP_TOKENS`（3,000）才延迟；一两台小服务器照旧
  常驻。
- **目录里一台一行**（`deferred:mcp:<id>`）：名字、id、工具数、描述、工具原名，约 65 token/台，
  30 台约 2.0k。服务器增减走提示词增量，追加在历史末尾。
- **切过去就不切回来。** 一个会话延迟加载过一次，之后即使工具少到阈值以下也保持延迟：阈值附近
  一台服务器断线重连，来回切一次就是两次整段前缀重算。
- **常驻**（设置 › MCP 里每台服务器的开关，`pinned`）：这台的工具留在工具表里，模型直接看到原生
  schema，也不进目录。改常驻会动工具表，所以只在改设置的那一下重算一次前缀；`pinned` 不算连接
  参数，改它不重连服务器。
- **注解照样生效。** `mcp_call` 换成真正的 MCP 工具以后，`destructiveHint` / 信任只读、审批的主体
  （真名字和参数）都和工具表里的一样。
- **直接按名字调没加载的工具**（模型从目录里猜出 `mcp__linear__create_issue`）也接住，等价于
  `mcp_call`。名字写错时先在同一台服务器里找最像的几个，找不到就列出那台的全部工具，而不是
  从 30 台里挑出别家名字相近的。
- 结果：工具表 + 目录每次请求从 38.7k 降到 9.8k（−74.8%）。

**阈值怎么来的。** 延迟加载每次请求多付两个入口加目录（3 台约 575 token），每发现一个工具多一次
请求，加上搜索结果，折合约 3.5k token；常驻 S token 的 schema 在一条请求序列（真实会话平均 25 次
请求、缓存读按一成算）里折合约 2.5·S。三台服务器、发现两次时两边在 S ≈ 3.4k 打平，取 3,000。
这个数是估算，偏差主要来自「一条序列里发现几次」，评测里多数任务是一次。

**评测**（`test/tool-eval/mcp-search-eval.ts`，2026-10-11，30 台假服务器、8 个任务、真模型，
延迟 vs 全部常驻）：

| 模型 | 延迟：通过 / 平均请求 / 平均输入 | 常驻：通过 / 平均请求 / 平均输入 |
| --- | --- | --- |
| deepseek-flash（Responses） | 8/8 · 3.8 · 15.0k | 7/8 · 2.3 · 71.4k |
| claude-sonnet-5-5（Messages） | 8/8 · 3.1 · 17.4k | 8/8 · 2.1 · 96.2k |
| gpt-6.1-sol（Responses） | 8/8 · 4.3 · 14.5k | 8/8 · 2.1 · 39.4k |

常驻那一侧 deepseek 唯一的失败是在 247 个工具里调错了 Stripe 的工具；延迟一侧有 2 次参数被校验
退回、改完都调对了。多出的一次多请求就是那次搜索。

已知上限：很少有服务器在 `initialize` 里给描述（`serverInfo.description` 或 `instructions` 第一行），
目录里多数服务器只有名字和工具名，搜索靠的是工具名和工具描述。

## 提示词

- 名字复用工具的 `qualifiedToolName`（`mcp__<服务>__<prompt>`），两台服务器都有 `review` 也不撞。
  `commands/expand.ts` 的调用名正则因此放进了 `_`。
- 列表按 `nextCursor` 翻页（最多 50 页）。SDK 自带的 `listChanged.autoRefresh` 只取第一页，所以
  关掉它，收到 `notifications/prompts/list_changed` 时自己重列。
- 参数绑定（`commands/mcp-prompt.ts`）在渲染进程里就做：缺必填参数不发，草稿留着。展开在主进程：
  有会话借会话的连接，新对话临时连那一台（`electron/mcp-probe.ts`）。`/` 菜单的 prompt 走单独的
  `commands.prompts`，不并进 `commands.list`——设置页和 `@` 提及也读后者，不该为此启动服务器。

## 填表（elicitation）

- 问人走审批那条通道（`ApprovalGate`，`kind: "form"`），卡片、倒计时、撤回、子代理停下时收卡都
  是现成的。`form` 和 `interactive` 一样**不会**被完全访问模式自动应答：那个模式给的是许可，不是答案。
- 三种回答：交值 → `accept`，「拒绝提供」→ `decline`，取消 / 超时 / 服务器撤回（`notifications/cancelled`
  触发 `extra.signal`）/ 会话收卡 → `cancel`。没人答不等于人说了不。
- 每台服务器一条队（`ElicitationQueue`）：一起摊开的话，后面几张的倒计时在人看见之前就在走。
- schema 只认规范允许的扁平原始类型（`mcp/form.ts`）。看不懂的整张拒掉（`InvalidParams`），不画
  缺格的表。同一份 `checkFormValues` 在窗口里画错误提示、在闸门里收答案（浏览器子入口
  `@plume/core/mcp-form`），两边不会一个说填好了、一个拒收。
- 能问人的宿主才声明 `elicitation.form`。命令行、设置页临时连的那一下不声明；服务器硬发来，用
  `fallbackRequestHandler` 回 `decline`，不让「方法不存在」拖垮整次工具调用。

## 登录（OAuth）

SDK 的 `auth()` 已经按规范做了发现（401 里的 `resource_metadata` → 路径插入的 well-known → 根
well-known；授权服务器元数据按 RFC 8414、OIDC 两种路径回退）、动态注册、PKCE、`resource` 参数、
刷新，以及传输层对 401 / 403 insufficient_scope 的重试。我们只实现 `OAuthClientProvider`，分两种：

| | 后台（会话、设置页探测、命令行） | 登录（设置页按钮，主进程） |
| --- | --- | --- |
| 令牌 | 每次从 vault 读，过期由 401 驱动刷新 | 不拿旧令牌，从头授权 |
| 注册 | 没有就抛 `McpNeedsLogin`，**不在后台注册** | 动态注册，结果存下来复用 |
| 跳转 | 走到这一步就抛 `McpNeedsLogin` | 系统浏览器 + 本机回调，校验 `state` |

几处必须这样写的地方：

- **`redirectUrl` 不能为空**：SDK 把它为空当作 client_credentials 那种无人值守授权，会直接去要令牌。
- **授权服务器换了**：SDK 会丢掉旧注册、重新注册。后台 provider 在 `clientInformation()` 里先比对
  刚存下的发现结果，拦成「需要登录」。
- **回调端口沿用注册时登记的那个**：授权服务器按 `redirect_uris` 精确比对。端口被占（`EADDRINUSE`）
  才换端口并重新注册——这是注册信息唯一会被丢掉的情况。
- **403 insufficient_scope**：刷新换不来更大的 scope，SDK 拿刷新令牌换完会再撞一次 403。后台 provider
  的 `fetch` 记下要的 scope，这一次不交出刷新令牌，于是走到跳转、变成「需要登录」；下次登录把
  401 的 scope、欠着的 scope、已有的 scope 合起来申请。
- **刷新只换一次**：POST 和 SSE 长连接、或同进程几个会话同时撞 401，各自刷新的话，轮换刷新令牌的
  授权服务器会给后到的回 `invalid_grant`，SDK 据此清掉刚换来的令牌。同一个刷新令牌的请求合并成一个；
  `invalidateCredentials("tokens")` 也只在 vault 里还是被拒的那张时才清。
- **没有任何 OAuth 元数据的 401** 是连接失败（多半要的是 API key 头），不说成「需要登录」。
- 配了 `Authorization` 请求头的服务器不挂 OAuth，人已经给了凭据。

- **跨进程只刷新一次**：桌面端和命令行会同时用同一台服务器。刷新请求在
  `<plume home>/locks/mcp-oauth-<url 哈希>.lock` 这把文件锁里发；拿到锁先重读 vault，别的进程已经
  换过（存着的刷新令牌和手上这张不同）就直接用它换来的，不再去撞 `invalid_grant`。新令牌写进 vault
  之后才放锁。
- **提前刷新**：令牌记下 `expiresAt`，剩余不到 60 秒（或不到有效期一半，取小）时，`tokens()` 先在
  后台刷新一次再交出令牌，省掉一次 401 往返；刷新失败照旧交出旧令牌，由 401 兜底。

存储：vault 里每台一条 `mcp-oauth:<服务器 id>`，记着所属 URL，地址改了整条作废。删除服务器时
`saveSettings` 一并清掉。退出登录只清令牌和发现结果，注册信息留着。vault 的每次读改写都在
`credentials.json.lock` 文件锁里（`utils/file-lock.ts`：`open(..., "wx")` 抢锁，持有期间定时
`utimes` 续命，超过 10 秒没续的视为持有者已死；只删自己写的那把），读取时按 inode、mtime、大小
判断别的进程是否改过、改过就重读。锁是文件不是 `flock`，Windows 上一样成立。

已知上限：

- 存着的注册被授权服务器单方面作废时，浏览器里会看到它的错误页，登录等到超时（五分钟）。
- 只做表单模式的 elicitation，没有 URL 模式。
