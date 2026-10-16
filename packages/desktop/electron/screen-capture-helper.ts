/**
 * macOS 截图快照的取屏小程序：拉起它、喂请求、收像素。
 *
 * desktopCapturer 拍出来的整屏没有窗口阴影，冻结画面和真实桌面不一样——截图一开阴影像被关掉了，
 * 按 Esc 又回来。小程序（`native/screen-capture.swift`）用 `SCScreenshotManager.captureImage(in:)`
 * 取「屏上看到的样子」，和系统截图一致。为什么是常驻小程序、而不是每次拉起或原生模块，见 ADR-0052。
 *
 * 这里只管「拿不拿得到」：拿不到（不是 macOS 15.2+、二进制不在、进程挂了、超时、回了错）就把原因
 * 交给调用方，由 `screenshot.ts` 退回 desktopCapturer。一张截图不能因为这条更好的路走不通而失败。
 *
 * 管道里是「一行 JSON 头 + 紧跟的像素字节」交替出现的流，块边界随意，`HelperStream` 负责把它切开。
 * 屏幕画面只走管道，不落盘。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BINARY = "plume-screen-capture";

export interface HelperLocation {
	packaged: boolean;
	/** `app.getAppPath()`：开发时是 `packages/desktop`。 */
	appPath: string;
	/** `process.resourcesPath`。 */
	resourcesPath: string;
}

/** 打包后是 mac `extraResources` 的 `to: screen-capture`；开发时是 `build-screen-capture.mjs` 放的位置。 */
export function screenCaptureHelperPath(where: HelperLocation): string {
	return where.packaged
		? join(where.resourcesPath, "screen-capture", BINARY)
		: join(where.appPath, "vendor", "screen-capture", BINARY);
}

/** `captureImage(in:)` 是 macOS 15.2 起才有的。`systemVersion` 是 `process.getSystemVersion()`，形如 `15.2.0`。 */
export function helperSupported(platform: string, systemVersion: string): boolean {
	if (platform !== "darwin") return false;
	const [major = 0, minor = 0] = systemVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
	return major > 15 || (major === 15 && minor >= 2);
}

export interface HelperFrame {
	id: number;
	width: number;
	height: number;
	/** RGBA8，逐行无填充，值在显示器自己的色彩空间里。 */
	pixels: Buffer;
	captureMs: number;
	convertMs: number;
	colorSpace: string;
}

export type HelperMessage =
	| { kind: "ready"; supported: boolean }
	| { kind: "frame"; frame: HelperFrame }
	| { kind: "error"; id: number; error: string }
	/** 头读不懂：后面的字节该算头还是像素已经无从知道，这条流只能扔掉。 */
	| { kind: "broken"; line: string };

/**
 * 把 stdout 切成一条条消息。
 *
 * 像素直接拷进按 `bytes` 预先分好的那块 Buffer：一帧五千多万字节、近千个块，攒起来再 `concat`
 * 要多拷一整遍。
 */
export class HelperStream {
	private pending: Buffer = Buffer.alloc(0);
	private body: { header: Omit<HelperFrame, "pixels">; pixels: Buffer; filled: number } | null = null;

	push(chunk: Buffer): HelperMessage[] {
		const out: HelperMessage[] = [];
		let at = 0;
		while (at < chunk.length) {
			if (this.body) {
				const take = Math.min(this.body.pixels.length - this.body.filled, chunk.length - at);
				chunk.copy(this.body.pixels, this.body.filled, at, at + take);
				this.body.filled += take;
				at += take;
				if (this.body.filled === this.body.pixels.length) {
					out.push({ kind: "frame", frame: { ...this.body.header, pixels: this.body.pixels } });
					this.body = null;
				}
				continue;
			}
			const newline = chunk.indexOf(0x0a, at);
			if (newline === -1) {
				this.pending = Buffer.concat([this.pending, chunk.subarray(at)]);
				break;
			}
			const line = Buffer.concat([this.pending, chunk.subarray(at, newline)]).toString("utf8");
			this.pending = Buffer.alloc(0);
			at = newline + 1;
			const message = this.header(line);
			if (message) out.push(message);
			if (message?.kind === "broken") break;
		}
		return out;
	}

	private header(line: string): HelperMessage | null {
		let head: Record<string, unknown>;
		try {
			head = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return { kind: "broken", line };
		}
		if (head.ready === true) return { kind: "ready", supported: head.supported === true };
		const id = typeof head.id === "number" ? head.id : -1;
		if (typeof head.error === "string") return { kind: "error", id, error: head.error };
		const { width, height, bytes } = head;
		if (typeof width !== "number" || typeof height !== "number" || typeof bytes !== "number" || bytes !== width * height * 4) {
			return { kind: "broken", line };
		}
		const header = {
			id,
			width,
			height,
			captureMs: typeof head.captureMs === "number" ? head.captureMs : 0,
			convertMs: typeof head.convertMs === "number" ? head.convertMs : 0,
			colorSpace: typeof head.colorSpace === "string" ? head.colorSpace : "",
		};
		if (bytes === 0) return { kind: "frame", frame: { ...header, pixels: Buffer.alloc(0) } };
		this.body = { header, pixels: Buffer.allocUnsafe(bytes), filled: 0 };
		return null;
	}
}

// ---------------------------------------------------------------------------
// 常驻进程
// ---------------------------------------------------------------------------

export type HelperResult = { ok: true; frame: HelperFrame } | { ok: false; reason: string };

/** 连着挂这么多次就不再拉起：反复崩的二进制不会因为再试一次就好，每次截图都白等一轮只是更慢。 */
const MAX_FAILURES = 3;

let location: HelperLocation | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<boolean> | null = null;
let failures = 0;
let nextId = 1;
const waiting = new Map<number, (message: Extract<HelperMessage, { kind: "frame" | "error" }>) => void>();

/** 告诉这个模块二进制在哪，并且现在就拉起它，第一次截图不再付启动的钱。不支持的机器上什么也不做。 */
export function startScreenCaptureHelper(where: HelperLocation): void {
	location = where;
	void launch();
}

function launch(): Promise<boolean> {
	if (ready) return ready;
	if (!location || !helperSupported(process.platform, process.getSystemVersion())) return Promise.resolve(false);
	if (failures >= MAX_FAILURES) return Promise.resolve(false);
	const path = screenCaptureHelperPath(location);
	if (!existsSync(path)) return Promise.resolve(false);

	const proc = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
	const stream = new HelperStream();
	child = proc;
	ready = new Promise<boolean>((resolve) => {
		let ended = false;
		// `error` 与 `exit` 可能先后都来，算一次。
		const gone = () => {
			if (ended) return;
			ended = true;
			failures++;
			resolve(false);
			if (child === proc) {
				child = null;
				ready = null;
			}
			for (const settle of waiting.values()) settle({ kind: "error", id: -1, error: "helper exited" });
			waiting.clear();
		};
		proc.once("error", gone);
		proc.once("exit", gone);
		proc.stdout.on("data", (chunk: Buffer) => {
			for (const message of stream.push(chunk)) {
				if (message.kind === "ready") {
					resolve(message.supported);
				} else if (message.kind === "broken") {
					proc.kill();
					return;
				} else {
					const id = message.kind === "frame" ? message.frame.id : message.id;
					waiting.get(id)?.(message);
					waiting.delete(id);
				}
			}
		});
		// 只为不让管道写满把它卡住；它没有什么要说给人听的。
		proc.stderr.resume();
	});
	return ready;
}

/**
 * 取一块屏幕。`rect` 是全局坐标、pt，和 Electron 的 `Display.bounds` 同一个坐标系。
 *
 * 超时就当这次拿不到：快照是在用户按下快捷键之后取的，多等的每一毫秒都是截图出现得更晚。
 * 超时以后才到的那一帧会被丢掉，流的切分不受影响。
 */
export async function captureWithHelper(
	rect: { x: number; y: number; width: number; height: number },
	timeoutMs = 1000,
): Promise<HelperResult> {
	const proc = (await launch()) ? child : null;
	if (!proc) return { ok: false, reason: unavailableReason() };
	const id = nextId++;
	return new Promise<HelperResult>((resolve) => {
		const timer = setTimeout(() => {
			waiting.delete(id);
			resolve({ ok: false, reason: `no answer in ${timeoutMs}ms` });
		}, timeoutMs);
		waiting.set(id, (message) => {
			clearTimeout(timer);
			resolve(message.kind === "frame" ? { ok: true, frame: message.frame } : { ok: false, reason: message.error });
		});
		proc.stdin.write(`${JSON.stringify({ id, rect: [rect.x, rect.y, rect.width, rect.height] })}\n`);
	});
}

function unavailableReason(): string {
	if (!location) return "not started";
	if (!helperSupported(process.platform, process.getSystemVersion())) return `unsupported on ${process.platform} ${process.getSystemVersion()}`;
	if (failures >= MAX_FAILURES) return `gave up after ${failures} failures`;
	if (!existsSync(screenCaptureHelperPath(location))) return "binary missing — run scripts/build-screen-capture.mjs";
	return "helper not running";
}
