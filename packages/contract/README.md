# @plume/contract

渲染进程与主进程之间那条线，写下来一次。

## 为什么是一个包

同一件事本来有两处描述，互相之间没有共同来源：

| 文件 | 说的是 |
| --- | --- |
| `desktop/electron/ipc-types.ts` | 方法的类型签名 |
| `desktop/electron/preload.ts` | 方法名到 channel 名的映射 |

漏 preload 是 `undefined is not a function`，漏主进程的 handler 是 `No handler registered`，
都要点到那个按钮才会暴露。

## 里面有什么

`src/methods.ts` 是那份清单。每个方法一行，写明 **channel**：IPC 通道名。它只在这里出现一次，
所以拼错是不可能的。`test/methods.test.ts` 把它和 preload、主进程的 `ipcMain.handle` 逐一比对。

## 边界

这个包**不依赖任何东西**。主进程与 preload 都从它读方法表，依赖谁就把谁拖进另一方的构建里。
`pnpm arch` 守着这一条。
