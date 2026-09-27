# 上下文组装与统计

主会话的组装入口是 `runtime/session-turn.ts`。规则、技能、记忆、环境和可用能力经
`runtime/prompt-context.ts` 加载，由 `prompt/system.ts` 产出一份提示词和段落来源。
每段记录来源、字符范围，以及适用时的文件路径和截断标记。
段落用字符范围引用同一份字符串，日志不重复保存正文。

借鉴 ZCode 的结构化来源与预算管理，保留 Lyra 的 system 注入语义、项目规则继承和
provider 接口。provider 缓存由各适配器处理。

## 缓存前缀

- system prompt 在会话内冻结。每轮仍按磁盘现状生成一份，但发出去的是冻结的那份；两者按段落
  （`PromptSource`，段落 id → 文本）比对，改了的段作为一条 `synthetic` 用户消息接在历史末尾并写进
  日志，开头的字节不变（`prompt/update.ts`、`session-turn.ts` 的 `settlePrompt`）。比对基准是模型
  此刻读到的各段：冻结那份叠上它看得到的历史里每一条增量，所以同一处改动只发一次，调上去又调回来
  也会补发。新增段落只要 `prompt.add` 一个新来源就纳入冻结与比对。
- 增量消息是 `<system-update>` 包着若干 `<section-update id="…">`，开头说明它来自运行时、不是用户
  发言、覆盖开头的同名段落；正文里的这两个标签和 `<session-summary>` 会被中和。结构化的改动存在
  `promptUpdate` 字段里，重启后不解析正文。三条协议都按普通用户消息发送，不依赖中途 system 消息。
- 冻结的那份不另存：每轮发出的 system prompt 本来就记为 `context` 事件，重启取最近一条、去掉中间件
  追加的部分即得原样字节。压缩（有边界）之后作废，下一轮按现状重新生成；撤回截掉的上下文跟着失效，
  退回更早那条，截到第一轮之前则重新生成。中间件整段替换过、或老日志没有段落信息时，重启后重新生成。
  压缩保留尾部里的旧增量不删除（会改变 `kept` 计数），它和新开头一致，只是重复。
- system prompt 不放随时间变化的文本：日期在消息末尾，项目记忆标绝对日期而不是「几天前」。
- 主会话的 `<env>` 日期块不进日志，由循环在每次请求时接在最末尾（`AgentRunConfig.environment`）。
  只在一轮开头接一次会让这一轮的回复排在它后面，下一轮从日志重建时前缀从那里断开。
- 子代理把带日期块的历史原样存下续跑，不开这个选项。
- 每次模型请求带 `AgentRunConfig.cacheKey`，协议层据此发缓存路由键：主会话用会话 id；子代理用
  自己的运行 id（`<会话 id>:sub:<短 id>`，续跑沿用，讨交接那一轮也用它）；侧聊用 `<会话 id>:side`，
  不与主会话混用，因为两边前缀不同。压缩摘要、标题生成、记忆抽取是一次性请求、前缀不复用，不带。
- 项目记忆与用户记忆按会话冻结，压缩（有边界）、撤回、重新载入时重读；`learn` 和后台抽取不再
  逐轮改 system prompt。人在设置里删改记忆立即作废快照；手工编辑文件、其他会话的 `learn` 等到
  下一次重读。重读到的变化在压缩时直接进新开头，其余时候作为增量接在末尾。`learned.md` 里没有时间戳的手写条目按文件修改时间标日期，同一份文件产出同一份字节。
- 派活关掉时 `task` 仍在工具表里，提示词只有一种说法；`@` 点名写进会话状态，由 `task` 执行时放行。
  auto 档下改推理等级仍会改变派活说明和并发上限：闸门随等级收放，提示词要说出同一个数字。
  这一段单独是 `delegation` 段，变化走增量；数字和闸门宽度都由 `delegationConcurrency` 按这一轮的档位算出。
- 剪枝产出的副本（循环里的按龄剪枝、空结果清空、压缩阶段的剪枝和摘要保留尾部）由会话的
  `AgedToolPruner` 按日志原文记住，下一轮重建历史时换回同一份。只在进程内有效，重启后按同样规则重剪。
- `read` 自己按字数截断（约 35k 字符），只把返回的行记为已读，并给出续读位置；超过
  `FRESH_RESULT_MAX_CHARS` 的新结果会在模型看到之前被剪成头尾。压缩阶段对模型还没看过的结果
  用同一条线，不再剪到 8k。
- 摘要请求的输入预算按实测 usage 与字符估算之比校正（只往保守方向），被压短的工具调用参数对象
  与原文同源，Anthropic 协议也能看到路径和命令。

## 缓存未命中诊断

`runtime/cache-diagnostics.ts` 的 `diagnoseCache` 对一条请求序列逐次算出本该命中而没命中的
token 和多花的钱，用来验收上面这些前缀修复、并定位前缀在哪一次请求被打断。主会话与每个子代理
各是一条序列，缓存前缀互不相干。`pnpm audit:sessions` 第 10 节在本机真实会话上汇总它；设置页
「用量」的「缓存未命中」一节按区间汇总同样的结果：扫描器（`electron/usage-scan.ts`）逐条推进
`diagnoseRequest`，每条序列的进度（`CacheDiagnosisState`）存进增量缓存，日志长了接着诊断。

- **期望前缀**：`min(上一次请求的 input + cacheRead + cacheWrite, 这一次的同一总量)`；
  未命中 = 期望 − 实际 cacheRead。Usage 四个桶互不重叠，所以只报 cacheRead 的服务商也适用。
- **多花**：未命中的 token 按这一次 input 与 cacheWrite 两桶的加权实付单价，减去缓存读单价。
  费率只取日志里请求当时存下的 `cost.rates`；没有（模型没配定价）就只报 token、不报钱。
- **原因**，按这个顺序判定：没有上一次 → 首个请求；未命中 ≤ 1024 token → 命中（缓存按块计，
  前缀完全稳定的请求也会差出几十个 token）；跨过压缩或撤回边界 → 前缀有意重写，不算打断；
  服务商/模型变了 → 换模型；这个服务商/模型从未报告过任何缓存 → 无从判断、不计未命中；
  距上一次请求开始超过 TTL → 空闲过期；其余 → 原因不明，即前缀被改动了。
- **TTL** 由调用方按请求声明，默认取服务商文档的下限：Anthropic `ephemeral` 5 分钟（Lyra 不申请
  1 小时档），OpenAI 自动缓存「5–10 分钟无访问后清除」，与 `prune.ts` 的 `CACHE_TTL_MS` 同一个数。
  取下限是让「原因不明」只剩缓存按说还活着的那些；按小时保留的服务商会因此把个别真打断算成过期。
  本机实测 DeepSeek 空闲 527 秒后 12.8 万 token 前缀只读到 2,048，5 分钟对它也不算保守过头。
- **已知误报**：DeepSeek 的缓存是请求结束后异步建的，两次请求隔几秒时后一次可能只读到更早的
  那份缓存，差出一千多 token、落进「原因不明」。榜单按未命中量排序，真正的打断排在它前面。

参考 pi 的 `cache-stats.ts`（逐轮比较上一轮输入、只报 cacheRead 的服务商在报告过缓存之后才计
整段未命中、压缩后重置）与 ZCode 的用量统计（摘要请求不进命中率，只读持久化的原始 usage）。
没照抄的：pi 的费用从本条消息的 cost 反推，没有存费率就是 0；「是否报告过缓存」按整段扫描粘住，
而中转服务商下同时有会缓存和不会缓存的模型，这里按服务商/模型分开记；pi 在压缩后直接不算，
这里仍算出重写的代价、只是原因归到压缩。

## 缓存用量

三条协议的 usage 解析都走 `ai/usage-fields.ts` 的 `USAGE_DIALECTS`：每条协议、每个桶
（input / output / cacheRead / cacheWrite / reasoning）一列候选字段，按优先级排，每行写明出处。
新增一个服务商变体只在对应列表里加一行，适配器不动。

- **input 含不含缓存是协议语义**：两条 OpenAI 协议的 `prompt_tokens` / `input_tokens` 含命中与写入，
  要扣掉；Anthropic 的 `input_tokens` 不含。DeepSeek 直接报了未命中数（`prompt_cache_miss_tokens`），
  有它就不做减法。含缓存的协议里，总输入与它含着的缓存桶同帧一起更新，否则扣的和存的不是同一个数。
- **同一个桶的几个字段是别名**，取第一个大于 0 的。pi 用 `a ?? b ?? c`，会停在中转在标准位置填的
  占位 0 上；ZCode 经 AI SDK 只认 `prompt_tokens_details.cached_tokens`，DeepSeek 与 Kimi 顶层的命中
  都记成 0。
- **没出现的桶不动**：Anthropic 的 `message_delta` 通常只带 `output_tokens`。
- 已覆盖的变体：OpenAI、OpenRouter（`cache_write_tokens`）、DeepSeek（hit / miss）、Kimi（顶层
  `cached_tokens`、`prompt_tokens_details.cache_write_tokens`）、Mistral 的两种写法、LiteLLM 转发
  Anthropic 时的顶层 `cache_*_input_tokens`、阿里云百炼显式缓存的 `cache_creation_input_tokens`。
  用例在 `test/usage-fields.test.ts`，一个变体一组。

## 缓存路由键

`RequestOptions.cacheKey` 是同一条对话前缀的稳定标识（主会话传会话 id，子代理各传区分开的 id）。
缓存命中按机器算，路由键让服务商把这些请求送到同一处。怎么带由 `ai/cache-routing.ts` 两张表决定：
`CACHE_CARRIERS`（携带方式）与 `CACHE_ROUTING_RULES`（按 baseUrl 主机名选方式，首条匹配生效）。

| 端点 | 默认 | 依据 |
| --- | --- | --- |
| `api.openai.com` | 请求体 `prompt_cache_key`（≤64） | OpenAI 文档，Chat 与 Responses 都有 |
| `openrouter.ai` | 请求头 `x-session-id`（≤256） | OpenRouter 文档：直接作为 sticky routing 键 |
| Kimi / Moonshot | 请求体 `prompt_cache_key` | Kimi Chat API 文档，建议传会话 id |
| `api.deepseek.com` | 不带 | 硬盘缓存按前缀自动命中，无路由参数 |
| Gemini OpenAI 兼容层 | 不带 | 未知字段 400，隐式缓存无路由参数 |
| 其他（通用中转） | 请求体 `prompt_cache_key` | 中转多把请求体原样转给 OpenAI 系上游 |
| Anthropic 协议 | 不带 | 协议没有对应字段，缓存靠 `cache_control` |

- **严格端点**：未知字段被拒且错误串点名 `prompt_cache_key` 时，`request-params-compat.ts` 学到
  `cache-key`，撤掉重发一次，本进程内这个模型不再带。请求头不参与学习：未知请求头几乎都被忽略。
- **拒了却不点名字段**的端点学不到，只能在配置里关（设置页服务商的「缓存路由」）：`ProviderConfig.cacheRouting` 取 `off`；也可以
  点名一种方式（`prompt_cache_key` / `x-session-id`），给表里没有、但已知认什么的中转用。缺省为 `auto`。
- **要求专门会话头的服务商**不进路由表，由 `sessionHeaders` 按地址写死：目前只有 OpenCode Go
  （`opencode.ai/zen/go`）的 `x-opencode-session`，缺了直接 400，做法同 ZCode `opencode-session.ts`。
  三种协议都带，不受 `cacheRouting: off` 影响；没有 `cacheKey` 的一次性请求（压缩、测试连接）给随机
  id 而不是不带。
- **超长或含非 ASCII 的键**压成「可读前缀-摘要」，不截断：pi 截到 64 字符，共享长前缀的主会话与
  子代理键会变成同一个。请求头只能是可见 ASCII，否则 `fetch` 直接抛错。
- 没照抄的：pi 在 Chat 链只对 `api.openai.com` 发 `prompt_cache_key`、在 Responses 链对所有端点发，
  两条链规则不同；ZCode 对所有请求都带 `x-session-id`，那是它自家服务端的归因头。

## 请求与统计共用的数据

```text
项目规则、技能、记忆、环境
          ↓
    提示词与来源段落
          ↓
     turn 中间件
          ↓
  context 事件保存实际提示词、段落范围和工具 schema
          ↓
  历史裁剪／压缩 → 请求快照 → provider 编码与发送
                      ↓
               上下文面板的统计
```

- 中间件追加提示词时保留原段落并标记扩展内容；完整替换时只记录扩展来源，避免把删除的
  规则算进统计。工具 schema 使用过滤之后真正发送的集合。
- 每次模型请求前，在裁剪、压缩及请求拒收恢复之后捕获上下文，后续已提交消息继续计入。
  手动压缩、恢复和撤回会使旧请求快照失效。
- 重启后复用日志中的 context 事件，避免磁盘上后来改变的规则影响旧请求的统计。
  旧事件没有段落信息时只报告已有提示词整体；没有 context 事件的会话走共用加载器预估。
- 统计中的段落大小仍是字符估算；有效 provider usage 决定总量，历史部分承担估算误差。
  provider 的序列化开销、缓存命中率和实际费用不能由段落字符数直接证明。

## 固定上下文预算

| 来源 | 规则 |
| --- | --- |
| 每份项目指令文件 | 正文最多 100 KiB UTF-8；在完整字符边界截断，附文件路径及读取全文的提醒 |
| 技能描述 | 每条最多 250 个 Unicode 字符；正文仍按需加载 |
| 技能目录 | 超过 20,000 字符时去掉描述，保留所有名称和路径；这是软预算，名称与路径本身仍可能超出 |
| 项目记忆 | learned 与 inferred 合并正文最多 200 行、25,000 字符，另附截断提示；信任说明及 XML 闭合标签保留 |

预算限制模型收到的副本，不改写原文件。项目规则继续从工作目录向仓库根收集，按祖先到子目录
排序；同目录保持 LYRA.md、AGENTS.md、CLAUDE.md 的既有优先级。用户全局自定义指令和记忆
沿用现有规则，不作为项目记忆裁剪。

上下文窗口的 80% 压缩触发线、裁剪节奏、任务事实快照与 recall 恢复机制见
[成本与停止机制](agent-cost-and-stopping.md)。本次组装调整不据历史重放宣称费用或完成率改善。

验证入口：`packages/core/test/context-assembly.test.ts`、`prompt-freeze.test.ts`，以及 system prompt 快照、上下文计量、
记忆、日志、压缩、撤回和 provider 相关测试。`scripts/audit-regression.mjs` 登记了组装守卫。
