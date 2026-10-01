import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import type { SessionMeta } from "@plume/core";
import { startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { fixtureStore, seedSessions, type FixtureRecord } from "./session-fixture.ts";

let app: RunningApp;
let projectPath: string;
let screenshots: string;
before(async () => {
	screenshots = await mkdtemp(join(tmpdir(), "plume-pr55-ui-"));
	app = await startApp({ port: 9615, seed: async (home) => {
		// Synthetic transcripts use the real storage and renderer paths.
		await seedInteractions(home);
		const store = fixtureStore(home);
		const logOf = async (id: string) => {
			const records: FixtureRecord[] = [];
			for await (const record of store.read(id)) records.push(record);
			return records;
		};
		const metas = [await store.get("qa-long"), await store.get("qa-short")] as SessionMeta[];
		const [longLog, shortLog] = [await logOf("qa-long"), await logOf("qa-short")];
		store.close();
		projectPath = metas[0].cwd;
		const third = { ...metas[1], id: "qa-third", title: "qa-third", updatedAt: 0 };
		/*
		 * 第二个项目只有一条归档会话：没有会话的项目不占行，会话全归档的项目默认保留一行，
		 * 这样它在列表里有标题可拖，又不多出一条会话行打乱下面对行序的断言。
		 */
		const secondArchived = { ...metas[1], id: "qa-second", title: "qa-second", cwd: join(home, "second"), projectId: "second", projectName: "第二项目", archived: true };
		metas[0].updatedAt = 30; metas[1].updatedAt = 20;
		const copyOf = (id: string): FixtureRecord[] => JSON.parse(JSON.stringify(shortLog).replaceAll("qa-short", id));
		seedSessions(home, [
			{ meta: metas[0], records: longLog },
			{ meta: metas[1], records: shortLog },
			{ meta: third, records: copyOf("qa-third") },
			{ meta: secondArchived, records: copyOf("qa-second") },
		]);
		const file = join(home, "settings.json");
		const settings = JSON.parse(await readFile(file, "utf8"));
		settings.projects.push({ id: "second", path: join(home, "second"), name: "第二项目", lastOpenedAt: 0 });
		await mkdir(join(home, "second"));
		settings.appearance = { theme: "light", reduceMotion: "off" };
		await writeFile(file, JSON.stringify(settings));
	} });
});
after(async () => {
	await app?.stop();
	if (screenshots) await rm(screenshots, { recursive: true, force: true });
});

async function point(target: "source" | "target" | "project", fraction = 0.5): Promise<{ x: number; y: number }> {
	const query = target === "source" ? `document.querySelector('[data-ly-row="qa-long"] > button')`
		: target === "target" ? `document.querySelector('[data-ly-row="qa-short"]')`
			: `document.querySelector('[class~="group/project"] > button[aria-expanded]')`;
	return app.evaluate(`(()=>{const e=${query};if(!e)throw new Error('drag target missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*${fraction}};})()`);
}
async function move(at: { x: number; y: number }, dragging = false) {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, buttons: dragging ? 1 : 0, ...(dragging ? { button: "left" } : {}) });
}
async function waitFor(expression: string): Promise<void> {
	await app.evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+5000;const check=()=>{if(${expression})resolve();else if(performance.now()<deadline)requestAnimationFrame(check);else reject(new Error('condition timed out'));};check();})`);
}
async function reload(): Promise<void> {
	const previous = await app.send<{ frameTree: { frame: { loaderId: string } } }>("Page.getFrameTree");
	const { targetInfo } = await app.send<{ targetInfo: { targetId: string } }>("Target.getTargetInfo");
	const response = await fetch("http://127.0.0.1:9615/json/list");
	const targets: { id: string; webSocketDebuggerUrl?: string }[] = await response.json();
	const target = targets.find((entry) => entry.id === targetInfo.targetId)?.webSocketDebuggerUrl;
	if (!target) throw new Error("Reload target missing");
	const socket = new WebSocket(target);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			let navigated = false;
			timer = setTimeout(() => reject(new Error("Reload did not finish loading a new document")), 5000);
			socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Page.enable" })));
			socket.addEventListener("error", () => reject(new Error("Reload debugger connection failed")));
			socket.addEventListener("close", () => reject(new Error("Reload debugger connection closed")));
			socket.addEventListener("message", (event: MessageEvent<string>) => {
				const message: { id?: number; method?: string; error?: { message: string }; params?: { frame?: { parentId?: string; loaderId: string } } } = JSON.parse(event.data);
				if (message.error) { reject(new Error(message.error.message)); return; }
				// Page.reload acknowledges the request while the previous DOM can still match.
				if (message.id === 1) socket.send(JSON.stringify({ id: 2, method: "Page.reload" }));
				// Only the new document's loader can satisfy the reload completion signal.
				if (message.method === "Page.frameNavigated" && message.params?.frame && !message.params.frame.parentId && message.params.frame.loaderId !== previous.frameTree.frame.loaderId) navigated = true;
				if (navigated && message.method === "Page.loadEventFired") resolve();
			});
		});
	} finally {
		clearTimeout(timer);
		socket.close();
	}
}
async function begin() {
	const start = await point("source"); const finish = await point("target", 0.8);
	await move(start);
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...start });
	await move({ x: start.x, y: start.y + 7 }, true);
	await move(finish, true);
	return finish;
}
async function release(at: { x: number; y: number }) {
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...at });
}
const rows = () => app.evaluate<string[]>(`[...document.querySelectorAll('[data-ly-row]')].filter(e=>e.checkVisibility({visibilityProperty:true})).map(e=>e.dataset.lyRow)`);

test("real mouse drag preserves other rows, suppresses navigation, and renders in both themes", async (t) => {
	await waitFor(`document.querySelector('[data-ly-row="qa-third"]')`);
	assert.deepEqual(await rows(), ["qa-long", "qa-short", "qa-third"]);
	const current = await app.evaluate(`document.querySelector('[data-ly-row] [aria-current="page"]')?.closest('[data-ly-row]')?.dataset.lyRow ?? null`);
	for (const theme of ["light", "dark"]) {
		await app.evaluate(`window.plume.settings.get().then(s=>window.plume.settings.save({...s,appearance:{...s.appearance,theme:${theme === "light" ? '"light"' : '"dark"'}}}))`);
		const finish = await begin();
		await waitFor(`document.querySelector('.ly-glass-solid.pointer-events-none.fixed')`);
		const ghost = await app.evaluate<{ width: number; height: number; left: number; top: number; position: string; text: string }>(`(()=>{const e=document.querySelector('.ly-glass-solid.pointer-events-none.fixed');const r=e.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,top:r.top,position:getComputedStyle(e).position,text:e.textContent};})()`);
		assert.equal(ghost.position, "fixed"); assert.equal(ghost.text, "qa-long");
		assert.ok(ghost.width > 40 && ghost.width <= 200); assert.ok(ghost.height > 20 && ghost.height < 45);
		assert.ok(Math.abs(ghost.left - finish.x - 12) < 1); assert.ok(Math.abs(ghost.top - finish.y - 12) < 1);
		const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(screenshots, `drag-${theme}.png`), Buffer.from(shot.data, "base64"));
		await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await release(finish);
		await waitFor(`!document.querySelector('.ly-glass-solid.pointer-events-none.fixed')`);
		assert.deepEqual(await rows(), ["qa-long", "qa-short", "qa-third"]);
		t.diagnostic(JSON.stringify({ theme, ghost }));
	}
	await release(await begin());
	await waitFor(`document.querySelector('[data-ly-row]')?.dataset.lyRow === 'qa-short'`);
	assert.deepEqual(await rows(), ["qa-short", "qa-long", "qa-third"]);
	assert.equal(await app.evaluate(`document.querySelector('[data-ly-row] [aria-current="page"]')?.closest('[data-ly-row]')?.dataset.lyRow ?? null`), current);
	const order = await app.evaluate<Record<string, string[]>>(`window.plume.settings.get().then(s=>s.sessionOrder)`);
	const stored = order[projectPath];
	assert.deepEqual(stored, ["qa-short", "qa-long", "qa-third"]);
	const originalDocument = await app.evaluate<number>("performance.timeOrigin");
	await reload();
	await waitFor(`[...document.querySelectorAll('[data-ly-row]')].filter(e=>e.checkVisibility({visibilityProperty:true})).length === 3 && document.querySelectorAll('[class~="group/project"] > button[aria-expanded]').length === 2`);
	assert.notEqual(await app.evaluate<number>("performance.timeOrigin"), originalDocument);
	assert.deepEqual(await rows(), stored);
});

test("project drag moves the whole group and does not collapse it", async () => {
	const headingsQuery = `document.querySelectorAll('[class~="group/project"] > button[aria-expanded]')`;
	const headings = await app.evaluate<number>(`${headingsQuery}.length`);
	assert.equal(headings, 2);
	const second = await app.evaluate<{ x: number; y: number }>(`(()=>{const r=${headingsQuery}[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.8};})()`);
	const start = await point("project");
	await move(start);
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...start });
	await move({ x: start.x, y: start.y + 7 }, true); await move(second, true); await release(second);
	await waitFor(`${headingsQuery}[0]?.textContent.includes('第二项目')`);
	assert.equal(await app.evaluate(`${headingsQuery}[1].getAttribute('aria-expanded')`), "true");
	assert.deepEqual(await rows(), ["qa-short", "qa-long", "qa-third"]);
	const saved = await app.evaluate<string[]>(`window.plume.settings.get().then(s=>s.projects.map(p=>p.path))`);
	assert.equal(saved[1], projectPath);
});
