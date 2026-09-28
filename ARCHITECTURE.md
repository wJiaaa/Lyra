# 架构

一页地图。每一节都指向真正的东西——目录、文件、或者一条记录了当初为什么这么定的 ADR。

## 一句话

Lyra 是一个 agent 运行时加一个桌面端。`packages/core` 平台无关，桌面端（Electron）驱动它的
`AgentSession`。打开 Web 访问后，局域网里的浏览器加载同一份界面、跟进同一批会话。

## 包

| 包 | 是什么 | 依赖谁 |
| --- | --- | --- |
| `core` | agent 内核：provider 适配、agent loop、工具、skill、MCP、会话存储 | 只依赖 `registry-shared` |
| `cli` | 非交互命令行：用桌面端的设置跑完一个任务，给评测用，见 [ADR-0031](docs/adr/0031-headless-cli-for-evaluation.md) | `core` |
| `desktop` | Electron 应用。`electron/` 主进程，`src/` 渲染进程，`shared/` 两边共有 | `core` |
| `registry-shared` | 插件市场的契约：索引能说什么、API 答什么 | 谁也不依赖 |

界面语言的来源、进程边界与不翻译的内容见 [界面国际化](docs/architecture/i18n.md)。
缓存、骨架屏与空结果在视图切换时的约定见 [视图切换与加载](docs/architecture/view-loading.md)。
模型请求的来源分段、固定预算和用量统计见 [上下文组装与统计](docs/architecture/context-assembly.md)。
浏览器怎么拿到界面、能调哪些方法、令牌怎么用，见 [Web 访问](docs/architecture/web-access.md) 与
[ADR-0027](docs/adr/0027-web-access.md)；移动端与中转已移除，见 [ADR-0026](docs/adr/0026-remove-mobile-and-relay.md)。

## 渲染进程的 9 个目录

```
src/
├── main.tsx      入口
├── app/          窗口怎么装起来：布局、快捷键、启动屏、窗口按钮、对话独立窗
├── features/     22 个用户看得见的域，各自一个目录
├── ui/           谁都能用的组件——换个产品也成立
├── lib/          纯逻辑：没有 React，没有主进程，不需要 DOM 就能测
├── services/     跟主进程说话的唯一出口
├── store/        跨域共享的状态；只有一个域用的留在那个域里
├── styles/       样式，一个主题一个文件
└── assets/
```

新文件该放哪，按依赖判断而不是按名字：

| 它 | 就放 |
| --- | --- |
| 不引 React，不碰主进程 | `lib/` |
| 是组件，但不读 store、不调 service | `ui/` |
| 知道「会话」「分支」「插件」是什么 | `features/<域>/` |
| 只有一个域读写的状态 | `features/<域>/store.ts` |
| 两个以上域读写的状态 | `store/` |

**「读写」两个字都算，数的时候别只数读。** 2026-09-12 的审计按「有几个文件读它」判断，点名
`store/index.ts` 里七个字段「只有一个 feature 文件读，违反这条规则」——逐个查下来七个全是跨域的，
而且是最典型的那种：`composerDraft` 一个域读、**七个域写**（子智能体面板、吐司、插件、PR、Git、
空状态都往主输入框塞过文字），`settingsSection` 九处写。一个域读、多个域写，正是这张表存在的理由，
不是违反它。

前两条由 `pnpm arch` 与 oxlint 强制。

## 边界

由 `.dependency-cruiser.cjs` 与 `.oxlintrc.json` 执行，`pnpm arch` 与 `pnpm lint` 检查，
pre-push 里都是必过项：

1. **`core` 不 import 桌面端。** 它是平台无关的运行时，一旦引了桌面端就不再是。
2. **渲染进程从 `core` 只能 `import type`**，白名单子入口除外。从根入口导入*值*会把整个
   index 拉进浏览器包，而它一路连到 `node:fs`——窗口一片空白。类型编译期就擦掉了，免费。
3. **渲染进程不从 `electron/` 导入值。** 类型可以（那是边界的描述），值就是把另一个进程的
   模块链进了这个包。
4. **`shared/` 谁也不依赖。** 它是两个进程共有的判断（比如「这个文件该用哪种查看器」），
   偏向任何一端就有一端用不了它。
5. **`@lyra/contract` 零依赖。** 它有三个消费者——主进程按它注册、preload 按它生成、
   渲染进程按 `WEB_METHODS` 决定浏览器里画什么——依赖谁就把谁拖进另外两个的构建里。
6. **`ui/` 与 `lib/` 是叶子。** 见上一节。
7. **`window.lyra` 只在 `services/bridge.ts`。** 由 oxlint 守；`host.ts` 读宿主、`web-bridge.ts` 在浏览器里搭它，是仅有的两处例外。
8. **`store`/`ui`/`lib`/`services` 不伸进某个功能域里点名文件。** 第 6 条的另一半：
   那一条只管域与域之间，从下面伸上去它看不见。壳（`app/`、`main.tsx`）不在此列——
   它们 `lazy()` 各域的整屏视图，而把那些视图放进域的出口会让打包器把整个域并回主 chunk。

循环依赖是 error，垫着一份已有的 118 条的基线（`.dependency-cruiser-known-violations.json`，
连同第 8 条那两处有理由的破例共 120 条）：新加一条会让 `pnpm arch` 变红，已有那些照旧通过。
这个数字每次 `pnpm arch` 都会印出来，少一条就 `pnpm arch:baseline` 重生成一次——那是让它下降的
正常动作，也是唯一能让它上升的动作。

从前这条规则是 warn 配一句「数字是要盯的东西」，没有东西在盯，于是它从 53 涨到了 159。装上棘轮
之后清了两轮没人用的转出，掉到 142——其中最后 16 条是删掉 `electron/git.ts` 里一个空的
`export {} from "./forge/index.ts"` 断掉的。每一次下降都由 `test/docs-numbers.test.ts` 逼着改
这一段：它要求这里写的数和基线里的一样多。最近一次是文件标签并入面板（119 → 118）：`files/FileTabs.tsx`
删掉了，经过它和 `dock/index.ts` 的那条环随之消失。

## 要做某件事，去哪

| 想做的 | 去 |
| --- | --- |
| 加一个 IPC | `packages/contract/src/methods.ts` 登记 → `electron/ipc/<域>.ts` 注册 → `electron/preload.ts` 暴露；契约的测试会检查三处一致。浏览器默认调不到；要开放就加进 `contract/src/web.ts` 并在 `electron/web-rpc.ts` 实现 |
| 加一个内置工具 | `core/src/tools/`，经 `useToolRegistry` 那条缝 |
| 加一个右侧面板 | `src/panels/registry.ts` 注册一条记录 |
| 维护模型价格、能力和中转别名 | `core/src/model-catalog.ts` 与 `scripts/update-model-catalog.mjs`；`pnpm catalog:update` 更新离线数据 |
| 宿主启动时装配内核 | `core/src/kernel/host.ts` 的 `bootHostKernel`；桌面端与终端共用，加一条缝只改这里 |
| 斜杠命令、skill 的解析与展开 | `core/src/commands/invoke.ts`（`@lyra/core/commands-view`）；桌面端输入框和命令行都走它 |
| 默认子智能体定义 | `core/src/agents-builtin.ts`；运行时与设置页共用，浏览器从 `@lyra/core/agents-builtin` 导入 |
| 改设计 token | `src/styles.css` 的 `@theme` 段 |
| 加一个基础组件 | `src/ui/<组>/`，配一条 `test/ui/` 的测试 |
| 加一个功能 | `src/features/<域>/`；跨域只经对方的 index |
| 调主进程 | `import { bridge } from "@/services"` |
| 判断命令危不危险 | `core/src/tools/risk*.ts` |
| 发版 | `pnpm release patch` |

## 检查

```bash
pnpm check   # lint + typecheck + test
pnpm arch    # 依赖方向
pnpm test:e2e  # 真实 Electron 窗口
```

`pnpm test`：纯逻辑的在各包 `test/` 下，组件的在 `packages/desktop/test/ui/`（happy-dom 真挂载）。
条数不写在这里——一个只会过期的数字，而它对任何决定都不起作用；要知道就跑一次。
e2e 在干净的 main 上有若干条稳定失败，**是哪几条没有写下来过**：从前这里指向
[docs/architecture/testing.md](docs/architecture/testing.md)，那份文档里没有这个清单。
在有人把它量出来写进去之前，这句话说的就是这个意思——不知道是哪几条。

## 决策记录

改动与这里写的不一致时，改这里，并在 [docs/adr/](docs/adr/) 里留一条。
