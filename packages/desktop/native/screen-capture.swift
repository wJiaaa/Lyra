// macOS 截图快照的常驻取屏小程序。主进程在 `electron/screen-capture-helper.ts` 里拉起它。
//
// 为什么不用 Electron 的 desktopCapturer：它走 ScreenCaptureKit 的内容过滤器
// （SCContentFilter(display:excludingWindows:)），拍出来的整屏**没有窗口阴影**，连窗口那圈 1px
// 描边也没有，显式 ignoreShadowsDisplay = false 也一样。冻结画面于是和真实桌面不一样：截图一开，
// 所有窗口的阴影像被关掉了，按 Esc 又回来。`SCScreenshotManager.captureImage(in:)`（macOS 15.2 起）
// 按矩形取「屏上看到的样子」，阴影和系统截图逐亮度一致，热启动 16–19ms。量法与数字见
// docs/adr/0052-macos-screenshot-helper.md。
//
// 协议（全部走管道，屏幕画面不落盘）：
//   启动后先写一行  {"ready":true,"supported":<是否 ≥ 15.2>}
//   stdin 每行一个请求  {"id":1,"rect":[x,y,w,h]}   全局坐标，pt，原点在主屏左上——和 Electron 的
//                                                   Display.bounds 同一个坐标系
//   stdout 回一行头      {"id":1,"width":…,"height":…,"bytes":…,"captureMs":…,"convertMs":…,"colorSpace":"…"}
//   紧跟 bytes 个字节    RGBA8，逐行，无行尾填充；颜色值保持显示器色彩空间里的原值，不做转换
//   出错时只有头         {"id":1,"error":"…"}
// stdin 关闭（主进程退出）就退出。
//
// 编译：scripts/build-screen-capture.mjs（arm64 + x86_64 通用二进制，部署目标 macOS 12，
// 15.2 以下运行时回 supported:false，主进程退回 desktopCapturer）。

import CoreGraphics
import Foundation
import ScreenCaptureKit

let stdout = FileHandle.standardOutput

func send(_ header: [String: Any], body: Data? = nil) {
	guard var line = try? JSONSerialization.data(withJSONObject: header) else { return }
	line.append(0x0A)
	stdout.write(line)
	if let body { stdout.write(body) }
}

func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func ms(since start: UInt64) -> Int { Int((Double(now() - start) / 1e6).rounded()) }

/// 原样画进一块 RGBA8 缓冲：色彩空间用图自己的，免得一次不必要的色彩转换改了像素值。
func rgba(_ image: CGImage) -> (Data, String)? {
	let w = image.width, h = image.height
	let own = image.colorSpace
	let space = own?.model == .rgb ? own! : CGColorSpace(name: CGColorSpace.sRGB)!
	var data = Data(count: w * h * 4)
	let drawn = data.withUnsafeMutableBytes { raw -> Bool in
		guard let ctx = CGContext(
			data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
		) else { return false }
		ctx.interpolationQuality = .none
		ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		return true
	}
	guard drawn else { return nil }
	return (data, (space.name as String?) ?? "unnamed")
}

func handle(_ line: String) async {
	guard let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
		let id = request["id"] as? Int,
		let r = request["rect"] as? [Double], r.count == 4 else {
		send(["id": -1, "error": "bad request"])
		return
	}
	guard #available(macOS 15.2, *) else {
		send(["id": id, "error": "needs macOS 15.2"])
		return
	}
	do {
		let t = now()
		let image = try await SCScreenshotManager.captureImage(in: CGRect(x: r[0], y: r[1], width: r[2], height: r[3]))
		let captureMs = ms(since: t)
		let c = now()
		guard let (pixels, colorSpace) = rgba(image) else {
			send(["id": id, "error": "could not convert the image"])
			return
		}
		send(
			["id": id, "width": image.width, "height": image.height, "bytes": pixels.count,
			 "captureMs": captureMs, "convertMs": ms(since: c), "colorSpace": colorSpace],
			body: pixels
		)
	} catch {
		send(["id": id, "error": error.localizedDescription])
	}
}

var supported = false
if #available(macOS 15.2, *) { supported = true }

// 读 stdin 放在自己的线程上：主线程留给 dispatchMain，ScreenCaptureKit 的回调可能要回到主队列，
// 在主线程上阻塞等它会把自己锁死。一次只处理一个请求，主进程本来也是一次只要一张。
Thread {
	send(["ready": true, "supported": supported])
	while let line = readLine() {
		let done = DispatchSemaphore(value: 0)
		Task.detached {
			await handle(line)
			done.signal()
		}
		done.wait()
	}
	exit(0)
}.start()

dispatchMain()
