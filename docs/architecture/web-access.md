# Web 访问

桌面端把自己的界面发给局域网里的浏览器：同一份渲染进程，同一批会话，回合进行中实时推送。
在「设置 → Web 访问」里打开，把那里给出的链接在手机、平板或另一台电脑的浏览器里打开即可。
决定与取舍见 [ADR-0027](../adr/0027-web-access.md)。

## 一份界面，两种宿主

```
渲染进程（一份代码）
   ├─ Electron 窗口 ──► preload ──► IPC ──► 主进程
   └─ 浏览器 ──► services/web-bridge.ts（网络版 window.plume）──► WebSocket ──► web-rpc 白名单
```

界面只认识 `window.plume`。窗口里它由 preload 从 IPC 搭出来；浏览器里没有 preload，
`web-bridge.ts` 按契约的方法表用一条 WebSocket 搭一个同样形状的对象。界面察觉不到差别，
所以两边不会各说各的。

| 文件 | 做什么 |
| --- | --- |
| `electron/web-access.ts` | 跟着 `settings.webAccess` 启停服务；启停排成一队，避免重复绑定端口 |
| `electron/web-server.ts` | HTTP + WebSocket：令牌换 Cookie、静态文件、RPC 分发、事件广播 |
| `electron/web-app.ts` | 发送 `out/renderer` 里构建好的界面 |
| `electron/web-rpc.ts` | 浏览器能调的方法及参数校验——**安全边界** |
| `electron/web-settings.ts` | 发给浏览器的设置去掉密钥、命令和令牌 |
| `contract/src/web.ts` | `WEB_METHODS`：白名单的声明，主进程与渲染进程读同一份 |
| `src/services/web-bridge.ts` | 浏览器里的 `window.plume` |
| `src/services/host.ts` | `onWeb()` 与 `available()`：界面在画控件之前问这个方法在这里答不答 |

## 能做什么，不能做什么

能：看会话列表与对话、发消息、停止、审批工具调用、编辑重发、侧边问答、子智能体与后台任务、
重命名/归档/删除会话、在**已打开的项目里**新建会话、只读浏览项目文件。

不能：改设置（`settings.save` 能写 hooks 与权限模式）、终端、写文件、截图、git 操作、插件、
更新、独立窗口、在访达或编辑器里打开。不在名单上的方法，界面按 `available()` 不画，调用返回 null。

**链接要按「能操作这台机器」保管。** 名单里没有终端，但 `agent.prompt` 在——拿到链接的人可以让
agent 在已打开的项目里执行命令。这是这个功能存在的理由，不是漏洞。两处收紧：新建会话的目录必须在
已打开的项目里；从网络来的附件 `path` 一律丢掉（`prompt-input.ts` 的 `PromptOrigin`）。

## 令牌

链接形如 `http://192.168.1.5:4517/?token=…`。第一次请求带着令牌来，服务端回一个 HttpOnly、
`SameSite=Strict` 的 Cookie 并跳转到去掉令牌的地址；之后文件和 WebSocket 都凭 Cookie，
页面脚本拿不到令牌。WebSocket 另外检查 `Origin` 必须是本服务。没有凭证的请求一律 401，静态文件也不例外。

「重新生成令牌」换一个新令牌并重启服务：已发出的链接全部失效，已连接的浏览器断开。

## 开发时

浏览器拿到的是 `packages/desktop/out/renderer` 里的构建产物。`pnpm dev` 下窗口从 Vite 加载，
这个目录可能是旧的或不存在——先 `pnpm build`，页面否则会提示它还没构建。
