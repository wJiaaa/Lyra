# ADR-0052：macOS 截图快照改由常驻的 Swift 取屏小程序来拍

- 状态：已采纳
- 日期：2026-10-16
- 相关：desktop `native/screen-capture.swift`、`electron/screen-capture-helper.ts`、
  `electron/screenshot.ts`（`captureFullDisplaySnapshot`、`warmCapturePipeline`）、
  `scripts/build-screen-capture.mjs`、`scripts/before-pack.mjs`、`scripts/check-native-arch.mjs`、
  `electron-builder.yml`

## 背景

截图一开，屏上所有窗口的阴影都没了；按 Esc 退出，阴影又回来。截图的冻结画面是先拍一张整屏、铺在覆盖层
上，所以问题出在那张整屏上：它和真实桌面不一样。

Electron 的 `desktopCapturer` 在 macOS 上走 ScreenCaptureKit 的
`SCContentFilter(display:excludingWindows:)`，按内容过滤器合成出来的画面**不带窗口阴影**，连窗口那圈
1px 描边也没有。`ignoreShadowsDisplay` 默认就是 `false`，显式设成 `false` 也一样。

在 macOS 27、2560×1440pt（5120×2880px）的屏上，取一个窗口边缘外侧的条带，和同一位置远处的桌面比亮度差：

| 取法 | 耗时（冷 / 热） | 阴影亮度差 |
| --- | --- | --- |
| SCK 内容过滤器，默认配置（即 `desktopCapturer`） | 96 / 30–37ms | 0 |
| SCK 内容过滤器，显式 `ignoreShadowsDisplay = false` | 32–34ms | 0 |
| `SCScreenshotManager.captureImage(in:)`（macOS 15.2+） | 32 / 16–19ms | 22.2 |
| `screencapture -x` 命令 | ~200ms + 解码 21ms | 22.2 |

`captureImage(in:)` 按矩形取「屏上看到的样子」，和系统截图逐亮度一致，而且比 `desktopCapturer` 还快。

## 决定

1. **macOS 15.2 起，快照由一个常驻的 Swift 小程序拍。** 它调 `captureImage(in:)`，拿显示器的
   `Display.bounds` 作矩形（全局坐标、pt，两边同一个坐标系），尺寸核对 `bounds × scaleFactor` 对得上才用。
2. **常驻，按需取。** 主进程在截图预热时拉起它，之后每次截图往 stdin 写一行请求，从 stdout 读回一行
   JSON 头加 RGBA8 像素。画面只走管道，不落盘。stdin 关闭就退出。
3. **拿不到就退回 `desktopCapturer`。** 系统低于 15.2、二进制不在、进程挂了、1 秒内没回、回了错，都只是
   这一次走旧路，日志里写明原因；连挂三次就不再拉起。一张截图不能因为这条更好的路走不通而失败。
4. **打包时编、随包带。** `beforePack` 在 macOS 上用 `swiftc` 编 arm64 与 x86_64 两份、`lipo` 合成通用
   二进制（部署目标 macOS 12，低于 15.2 时运行时回 `supported:false`），经 `extraResources` 放到
   `Resources/screen-capture/`，和 ripgrep 同一种放法。`check-native-arch.mjs` 核对它在、架构对。
   开发时 `postinstall` 顺带编一份到 `vendor/`，编不了只警告。
5. **颜色不转换。** 像素保持显示器自己色彩空间里的原值（通常是 Display P3），画布照旧按
   `Display.colorSpace` 选色彩空间——和 `desktopCapturer` 那条路一样，覆盖层上看到的颜色不变。

## 代价

- **构建依赖 Xcode 命令行工具。** 打 macOS 包的机器要有 `swiftc`；CI 的 macOS runner 自带。
- **多一个进程。** 常驻时几 MB 内存；它继承 Plume 的屏幕录制授权（TCC 记在拉起它的应用上），不多弹授权。
- **一帧五千多万字节过一次管道。** 5K 屏上一帧约 59MB，主进程按头里的字节数预分配、边收边拷，不攒块。

## 没有做的

- **不每次截图现拉一个进程。** 冷启动那一次 SCK 要 96ms，而快照是在用户按下快捷键之后取的；常驻把这笔
  钱挪到了预热里。
- **不写 N-API 原生模块。** 要跟着 Electron 的 ABI 每个版本重编，崩了把主进程一起带走；小程序挂了只是
  退回旧路。
- **不用 `screencapture` 命令。** 有阴影，但 200ms 外加读文件、解码，而且画面要落一次盘。
- **不在覆盖层上画假阴影。** 阴影的形状、浓淡、激活与否各窗口都不一样，画出来只会是另一种不像。

## 什么时候重新看

- Electron 的 `desktopCapturer` 改用 `captureImage(in:)` 或别的带阴影的取法：小程序可以删掉。
- 最低支持的 macOS 提到 15.2 以上：`desktopCapturer` 那条退路在 macOS 上只剩兜底，可以考虑简化。
- Apple 给内容过滤器加上「包含阴影」的选项：同上。
