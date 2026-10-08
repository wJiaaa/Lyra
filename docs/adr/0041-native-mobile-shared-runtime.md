# ADR-0041：独立手机 UI，共享运行时

日期：2026-10-08

状态：已采纳；取代 ADR-0026 中不提供手机端的决定。「不提供中转」一项已被 [ADR-0042](0042-mobile-relay-speaks-lyra.md) 取代。

## 背景

用户需要在手机上继续桌面的任务，并要求像 t3code 一样，手机界面独立设计、底层逻辑复用。复用桌面 HTML 会把多栏窗口、文件面板和桌面交互一起带到手机。

## 决定

新增 `packages/mobile`（React Native / Expo）与 `packages/client-runtime`（无 UI）。桌面的消息合并函数移动到共享包，原入口保留重导出。共享包负责连接、RPC、事件合并与重连；core 的数据类型从 type-only 入口提供，手机不运行 Node / Electron 或第二个 Agent。

桌面主进程提供显式开启的 HTTP / WebSocket 服务，RPC 只允许会话与 Agent 操作。它直接调用现有 session hub、存储和授权处理，不复制 agent loop。读取历史仍走冷读取。项目只能按桌面登记的 ID 选择，不能提交任意 cwd；模型必须已启用。Bootstrap 只包含项目与模型的展示字段，不传 provider 设置和密钥，事件通道不传调试请求。

令牌在 WebSocket 的首帧校验，不放在连接 URL 中。桌面以 0600 保存访问配置；原生设备使用 SecureStore。关闭监听、重置令牌都会断开连接。服务有握手时限、请求大小、并发与发送积压限制；断线重新读取快照，不重放写请求。

## 影响

手机可操作同一份会话，界面与桌面可分别演进。网络访问默认关闭；本期只支持直连、VPN 或用户配置的 HTTPS 反向代理，不提供云中转、同步副本和后台 agent 宿主。原生打包与商店发布属于独立后续发布工作。

运行方式及当前能力见 [Mobile README](../../packages/mobile/README.md)，视觉规则见 [DESIGN](../../packages/mobile/DESIGN.md)。
