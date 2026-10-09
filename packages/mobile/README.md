# Plume Mobile

独立的 React Native / Expo 手机 App。手机界面单独设计，Agent、模型配置、项目与会话存储仍由桌面 Plume 承载。桌面和手机共享 `@plume/client-runtime` 的消息合并逻辑；远程连接、重连和会话状态也放在这个无 UI 的包里。

## 启动与配对

1. 在仓库根目录执行 `pnpm install`，再执行 `pnpm dev` 启动桌面。
2. 桌面「设置 → 手机连接」开启访问，默认端口为 4517。此功能初始关闭；开启状态和令牌仅保存在电脑的 `mobile-access.json`（文件权限 0600）。
3. 执行 `pnpm dev:mobile`，在支持 Expo SDK 57 的 Expo Go 中打开；也可执行 `pnpm dev:mobile:ios` 或 `pnpm dev:mobile:android` 在模拟器启动。
4. 在手机 App 扫描桌面配对二维码，或将「复制配对链接」粘贴到地址输入框。也支持手动输入 HTTP / HTTPS 地址与令牌。模拟器连接本机时使用 `http://127.0.0.1:4517`；Android 模拟器使用宿主地址 `http://10.0.2.2:4517`。

直连要求手机与电脑在同一网络或可达的 VPN。监听端口开放于电脑的网络接口，请仅在可信网络启用。

不在同一网络时走中转：在桌面「设置 → 手机连接 → 中转服务器」填上 Lyra 中转地址（如 `wss://relay.example.com`），二维码会优先带上这条路。Plume 不自带中转，直接用 Lyra 的 `packages/relay`。中转能看到会话内容和令牌，只用自己部署的中转，见 [ADR-0042](../../docs/adr/0042-mobile-relay-speaks-lyra.md)。经中转同一时间只连一部手机。

## 当前能力

搜索、创建、打开、重命名、归档和恢复会话；流式回复、Markdown（代码块可复制）、思考与工具结果，编辑看 diff、命令看输出与退出码，做完的一轮折成一行摘要；计划清单进度；发送文字和图片（相册或拍照，发前缩到长边 1568 的 JPEG，一条最多 4 张）、停止任务、出错重试；模型和思考档位选择；普通授权、交互问题与多选回答；后台恢复后重连并重新读取权威快照。

原生设备的配对令牌保存在 SecureStore。断开并忘记会删除本机令牌；桌面重置令牌会断开旧客户端。重连不会自动重发写请求，发送失败时输入草稿保留。电脑必须保持 Plume 运行。

文件附件、文件浏览、终端、多窗口与桌面截图能力未加入手机界面。从存储读回的历史大图只剩电脑上的引用，手机上显示「图片保存在电脑上」。原生界面不加载桌面 HTML 或 WebView。

## 验证与构建

`pnpm --filter @plume/mobile typecheck`、`pnpm --filter @plume/mobile test`、`pnpm check`。

`pnpm --filter @plume/mobile web` 用 React Native Web 预览同一套手机组件；`pnpm --filter @plume/mobile build:web` 导出预览。原生开发构建可在包目录执行 `pnpm exec expo run:ios` / `pnpm exec expo run:android`，需对应平台 SDK。iOS 27 要求 App 采用 UIScene 生命周期，否则启动即退出；`plugins/with-scene-lifecycle.cjs` 在 prebuild 时接上 Expo 的 `ExpoAppSceneDelegate`，Expo 模板自带后可删。应用标识为 `app.plume.mobile`，配对 deep link scheme 为 `plume`；Expo Go 内使用扫码或手动输入，安装独立开发构建后可直接打开 `plume://pair` 链接。

可侧载的 Android APK 由 GitHub Actions 的「安装包」工作流打出（平台选 `android`），见 [CONTRIBUTING.md](../../CONTRIBUTING.md#在-github-构建安装包)。
