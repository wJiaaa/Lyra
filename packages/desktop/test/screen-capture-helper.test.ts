/**
 * The macOS screenshot helper's side of the pipe: where it lives, which systems it runs on, and how
 * its stdout is cut into frames.
 *
 * The stream is the part that can go wrong quietly. A frame is fifty-odd megabytes arriving in a
 * thousand chunks with no regard for where the header ends, and a parser that loses one byte does
 * not fail — it shifts every pixel after it, or reads the next header out of the middle of a picture.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { HelperStream, helperSupported, screenCaptureHelperPath, type HelperMessage } from "../electron/screen-capture-helper.ts";

function frameBytes(id: number, width: number, height: number, fill: (i: number) => number): Buffer {
	const pixels = Buffer.alloc(width * height * 4);
	for (let i = 0; i < pixels.length; i++) pixels[i] = fill(i);
	const header = JSON.stringify({ id, width, height, bytes: pixels.length, captureMs: 16, convertMs: 3, colorSpace: "kCGColorSpaceDisplayP3" });
	return Buffer.concat([Buffer.from(`${header}\n`), pixels]);
}

test("a frame cut into single bytes comes out whole and exact", () => {
	const stream = new HelperStream();
	const bytes = frameBytes(4, 3, 2, (i) => (i * 7) % 256);
	const messages: HelperMessage[] = [];
	for (let i = 0; i < bytes.length; i++) messages.push(...stream.push(bytes.subarray(i, i + 1)));
	assert.equal(messages.length, 1);
	const [message] = messages;
	assert.equal(message?.kind, "frame");
	if (message?.kind !== "frame") return;
	assert.equal(message.frame.id, 4);
	assert.deepEqual([message.frame.width, message.frame.height], [3, 2]);
	assert.deepEqual([...message.frame.pixels], Array.from({ length: 24 }, (_, i) => (i * 7) % 256));
});

test("ready, a frame, an error and the next frame in one chunk are four messages in order", () => {
	const stream = new HelperStream();
	const chunk = Buffer.concat([
		Buffer.from('{"ready":true,"supported":true}\n'),
		frameBytes(1, 1, 1, () => 10),
		Buffer.from('{"id":2,"error":"denied"}\n'),
		frameBytes(3, 2, 1, () => 0x0a), // pixel bytes that look like newlines must stay pixels
	]);
	const messages = stream.push(chunk);
	assert.deepEqual(
		messages.map((m) => m.kind),
		["ready", "frame", "error", "frame"],
	);
	const last = messages[3];
	assert.ok(last?.kind === "frame" && last.frame.pixels.every((b) => b === 0x0a));
});

test("a header whose byte count is not width × height × 4 breaks the stream instead of guessing", () => {
	const stream = new HelperStream();
	const messages = stream.push(Buffer.from('{"id":1,"width":2,"height":2,"bytes":15}\n'));
	assert.equal(messages[0]?.kind, "broken");
});

test("a line that is not JSON breaks the stream", () => {
	assert.equal(new HelperStream().push(Buffer.from("Fatal error: something\n"))[0]?.kind, "broken");
});

test("only macOS 15.2 and later have captureImage(in:)", () => {
	assert.equal(helperSupported("darwin", "15.2.0"), true);
	assert.equal(helperSupported("darwin", "15.10"), true);
	assert.equal(helperSupported("darwin", "26.0"), true);
	assert.equal(helperSupported("darwin", "15.1.1"), false);
	assert.equal(helperSupported("darwin", "14.7"), false);
	assert.equal(helperSupported("win32", "10.0.26100"), false);
	assert.equal(helperSupported("linux", "6.8.0"), false);
});

test("the packaged copy is in Resources, the development copy where the build script puts it", () => {
	const where = { appPath: "/repo/packages/desktop", resourcesPath: "/Applications/Plume.app/Contents/Resources" };
	assert.equal(screenCaptureHelperPath({ ...where, packaged: true }), "/Applications/Plume.app/Contents/Resources/screen-capture/plume-screen-capture");
	assert.equal(screenCaptureHelperPath({ ...where, packaged: false }), "/repo/packages/desktop/vendor/screen-capture/plume-screen-capture");
});

// 两处对不上时什么也不报：截图照常能用，只是悄悄退回了没有阴影的 desktopCapturer。
test("the installer puts the helper where the main process looks for it", () => {
	const desktop = fileURLToPath(new URL("..", import.meta.url));
	type Resource = { from: string; to: string; filter?: string[] };
	const config = parse(readFileSync(join(desktop, "electron-builder.yml"), "utf8")) as { mac: { extraResources: Resource[] } };
	const entry = config.mac.extraResources.find((resource) => resource.to === "screen-capture");
	assert.ok(entry, "mac.extraResources has no screen-capture entry");
	assert.ok(entry.filter?.includes("plume-screen-capture"));
	assert.equal(screenCaptureHelperPath({ packaged: true, appPath: "", resourcesPath: "/res" }), join("/res", entry.to, "plume-screen-capture"));
	assert.equal(screenCaptureHelperPath({ packaged: false, appPath: desktop, resourcesPath: "" }), join(desktop, entry.from, "plume-screen-capture"));
});

/*
 * The real binary, when this machine has one: the protocol is two programs agreeing, and only
 * running both shows they do. A 1pt rectangle is a 2×2 frame on Retina — or an error, without
 * screen recording access; either way it must be an answer to *this* request, cleanly framed.
 */
const binary = join(fileURLToPath(new URL("..", import.meta.url)), "vendor", "screen-capture", "plume-screen-capture");
test("the built helper answers a request in the framing this side expects", { skip: !existsSync(binary) && "helper not built" }, async () => {
	const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
	const stream = new HelperStream();
	const messages: HelperMessage[] = [];
	const answered = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer: ${JSON.stringify(messages.map((m) => m.kind))}`)), 10_000);
		proc.stdout.on("data", (chunk: Buffer) => {
			messages.push(...stream.push(chunk));
			if (messages.some((m) => (m.kind === "frame" && m.frame.id === 9) || (m.kind === "error" && m.id === 9))) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	proc.stdin.write(`${JSON.stringify({ id: 9, rect: [0, 0, 1, 1] })}\n`);
	try {
		await answered;
	} finally {
		proc.stdin.end();
		proc.kill();
	}
	assert.equal(messages[0]?.kind, "ready");
	assert.ok(!messages.some((m) => m.kind === "broken"));
});
