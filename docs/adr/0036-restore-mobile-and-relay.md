# ADR-0036：恢复移动端与中转，撤掉 Web 访问

- 状态：已采纳
- 日期：2026-10-04
- 相关：取代 [ADR-0026](0026-remove-mobile-and-relay.md)、[ADR-0027](0027-web-access.md)；恢复
  [ADR-0001](0001-mobile-hosts-the-desktop-renderer.md)、[ADR-0002](0002-relay-knows-nothing.md)、
  [ADR-0012](0012-one-contract-not-three.md) 的手机一侧

## 背景

ADR-0026 删掉了移动端与中转，ADR-0027 用一个局域网里的浏览器入口补回了「在电脑之外跟进回合」。
两件事加起来，让这个 fork 与上游 kittors/Lyra 在同一批文件上走成了两条路：上游继续在
`sync-*.ts`、`packages/mobile`、`packages/relay` 和契约的 `remote` 声明上修问题（ADR-0037 那一轮
大数据传输就是），而这里同名的位置要么不存在、要么是另一套 `web-*.ts`。每次合入上游，这些改动
都得逐个手工判断，合并的成本一次比一次高。

Web 访问能做的事，手机外壳都能做（同一份界面、同一份白名单思路），反过来不成立：它没有配对、
没有中转，出了局域网就够不着。

## 决定

按上游整套恢复，文件名与结构对齐上游，以便之后直接合并：

- `packages/mobile`（Expo 外壳）、`packages/relay`（中转），主进程的同步服务
  （`electron/sync*.ts`、`phone-settings.ts`），渲染进程的手机适配（`src/mobile/`、`styles/phone*.css`、
  `onPhone()` / `available()` 分支），契约里每个方法的 `remote` / `why`。
- 撤掉 Web 访问：`electron/web-*.ts`、`services/web-bridge.ts`、`contract/src/web.ts`、设置页与
  `settings.webAccess`。白名单的内容并入契约，原来 Web 能调的方法在 `remote` 里同样为真，另外
  加上手机可写设置的 `settings.save`。

没有跟着恢复的是 ADR-0026 之外、这个 fork 有意删掉的东西：`packages/agent-cli`、额外的五种界面
语言、CI 与发版流水线。手机安装包因此不进 `pnpm release`，在本地按
[手机端怎么打包](../architecture/mobile-packaging.md) 打。

这个 fork 自己加的方法，`remote` 按同样的标准逐个判断：读本机进程输出、配置钩子、拉模型目录、
探测 MCP 的为假；关闭侧边对话为真。

## 后果

- 加 IPC 时要回答「手机能不能调」，写在契约那一行上，`sync-rpc.ts` 实现。
- 会话存储、侧边对话、钩子配置等与上游不同的地方，在 `sync-rpc.ts` / `sync-server.ts` 里按这个 fork
  的接口改写过；合并上游这两个文件时要留意这些差异。
- 发版时版本号多写三处（两个包和 `app.json`），`app.json` 的构建号由 `pnpm release` 一并写入。

## 什么时候该重新考虑

上游再次删掉移动端，或这个 fork 决定不再跟随上游合并时。
