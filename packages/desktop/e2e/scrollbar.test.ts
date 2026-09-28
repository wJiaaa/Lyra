/**
 * Can the scrollbar be grabbed?
 *
 * A thumb that renders, is visible, and cannot be pressed is the worst kind of broken control:
 * everything about it says it works. Nothing short of running the app answers this, because the
 * answer is decided by hit-testing — `pointer-events` on an ancestor, a mask, something layered
 * over the strip — and none of that is visible in the markup of any one component.
 *
 * The structure is built here rather than found in the app, on purpose. A fresh profile has no
 * conversation and no long file, so there may be nothing on screen that overflows; and what is
 * under test is the contract between `Scroller`'s DOM and the stylesheet's, both of which this
 * mirrors exactly. If it drifts from `Scroller.tsx`, that is a real difference worth failing on.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stopProcessGroup } from "./app.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PORT = 9445;
const BOOT_TIMEOUT_MS = 90_000;

let app: ChildProcess | undefined;
let home: string;
let target: string;
const output: string[] = [];

before(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-e2e-scroll-"));
	app = spawn("pnpm", ["exec", "electron-vite", "preview", "--", `--remote-debugging-port=${PORT}`], {
		cwd: ROOT,
		env: { ...process.env, PLUME_HOME: home, ELECTRON_ENABLE_LOGGING: "1" },
		stdio: "pipe",
		detached: true,
	});
	const record = (chunk: Buffer) => {
		output.push(chunk.toString());
		if (process.env.DEBUG_E2E) process.stdout.write(chunk);
	};
	app.stdout?.on("data", record);
	app.stderr?.on("data", record);
	app.on("error", (error) => output.push(`spawn failed: ${error.message}`));

	target = await waitForWindow();
	await waitForShell();
	await evaluate(BUILD_PROBE);
});

after(async () => {
	await stopProcessGroup(app);
	await rm(home, { recursive: true, force: true }).catch(() => {});
});

/**
 * A `Scroller`, rebuilt from its own markup, parked where nothing else can be over it.
 *
 * Class names and inline styles are copied from `Scroller.tsx`; the stylesheet under test is the
 * app's own, already loaded. Positioned at the top-left rather than at the window's edge, so the
 * one thing this cannot control — the OS resize border along the frame — is out of the way.
 */
const BUILD_PROBE = `(() => {
	document.getElementById("ly-probe")?.remove();
	const host = document.createElement("div");
	host.id = "ly-probe";
	host.className = "ly-scroll-host relative flex min-h-0 flex-col";
	host.style.cssText = "position:fixed;left:40px;top:40px;width:320px;height:240px;z-index:99999";
	host.innerHTML = \`
		<div id="ly-probe-view" class="ly-scroll-view min-h-0 flex-auto overflow-y-auto overscroll-contain ly-fade-y"
		     style="--ly-fade-top:0px;--ly-fade-bottom:48px">
			<div style="height:2000px">tall</div>
		</div>
		<div id="ly-probe-track" class="pointer-events-none absolute top-0 right-0 bottom-0 z-40 w-[10px]">
			<div id="ly-probe-thumb" class="ly-thumb absolute right-[2px] w-[6px] rounded-full bg-ink-faint"
			     style="top:0px;height:60px"></div>
		</div>\`;
	document.body.appendChild(host);
	return true;
})()`;

test("the thumb is what the pointer lands on where the thumb is drawn", async () => {
	const hit = await evaluate<{ id: string | null; classes: string; x: number; y: number }>(`(() => {
		const thumb = document.getElementById("ly-probe-thumb");
		const box = thumb.getBoundingClientRect();
		const x = Math.round(box.left + box.width / 2);
		const y = Math.round(box.top + box.height / 2);
		const at = document.elementFromPoint(x, y);
		return { id: at?.id ?? null, classes: at?.className ?? "", x, y };
	})()`);

	// The failure this catches: the track is `pointer-events: none` and the thumb has to opt back
	// in, so anything else answering here means the press never reaches the drag handler.
	assert.equal(hit.id, "ly-probe-thumb", `pointer at ${hit.x},${hit.y} landed on "${hit.classes}"`);
});

test("a press on the thumb reaches it even before the scroller has been hovered", async () => {
	const got = await evaluate<boolean>(`(() => {
		const thumb = document.getElementById("ly-probe-thumb");
		const box = thumb.getBoundingClientRect();
		let seen = false;
		const mark = () => { seen = true; };
		thumb.addEventListener("mousedown", mark, { once: true });
		const at = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
		at?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: box.left + 3, clientY: box.top + 30 }));
		thumb.removeEventListener("mousedown", mark);
		return seen;
	})()`);

	assert.equal(got, true, "mousedown never reached the thumb");
});

/**
 * How wide the grab really is, measured rather than read off the stylesheet.
 *
 * Six pixels is what it looks like; six pixels is also what it *was*, and a 6px target pinned to
 * the edge of a window is a target most people miss — which is indistinguishable, in use, from a
 * scrollbar that cannot be dragged at all.
 */
test("the grab area is wider than the mark it draws", async () => {
	const reach = await evaluate<{ visible: number; grabbable: number }>(`(() => {
		const thumb = document.getElementById("ly-probe-thumb");
		const box = thumb.getBoundingClientRect();
		const y = Math.round(box.top + box.height / 2);
		const isThumb = (x) => {
			const at = document.elementFromPoint(x, y);
			return at === thumb || at?.parentElement === thumb;
		};
		let left = Math.round(box.left);
		while (left > box.left - 40 && isThumb(left - 1)) left -= 1;
		let right = Math.round(box.right);
		while (right < box.right + 40 && isThumb(right)) right += 1;
		return { visible: Math.round(box.width), grabbable: right - left };
	})()`);

	// Twelve is the floor, not the target: it is roughly where a 6px bar against a window edge
	// stops being a coin-flip. The rule that provides it reaches inwards, away from the frame.
	assert.ok(
		reach.grabbable >= 12,
		`only ${reach.grabbable}px of it can be pressed (the mark itself is ${reach.visible}px)`,
	);
});

// ---------------------------------------------------------------------------

async function waitForWindow(): Promise<string> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`)
			.then((r) => r.json() as Promise<{ title: string; type: string; webSocketDebuggerUrl?: string }[]>)
			.catch(() => null);
		const page = targets?.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`no window after ${BOOT_TIMEOUT_MS / 1000}s. What the app printed:\n${output.join("").slice(-4000) || "(nothing)"}`,
	);
}

async function waitForShell(): Promise<void> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let last = "";
	while (Date.now() < deadline) {
		const state = await evaluate<{ shell: boolean; body: string }>(
			`({ shell: Boolean(document.querySelector(".ly-shell")), body: document.body.innerText.slice(0, 120) })`,
		).catch(() => null);
		if (state?.shell) return;
		last = state?.body ?? "(no answer from the renderer)";
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`the shell never rendered. What was on screen:\n${last}`);
}

async function evaluate<T>(expression: string): Promise<T> {
	const socket = new WebSocket(target);
	try {
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const answer = new Promise<T>((resolve, reject) => {
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data));
				if (message.id !== 1) return;
				if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
				else resolve(message.result?.result?.value as T);
			});
			setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 60)}`)), 15_000);
		});
		socket.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: { expression, awaitPromise: true, returnByValue: true },
			}),
		);
		return await answer;
	} finally {
		socket.close();
	}
}
