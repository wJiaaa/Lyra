import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, focus, frames, openSession, press, shot, until } from "./drive.ts";
import { encode, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

interface Geometry {
	height: number;
	top: number;
	sliderY: number;
	descriptionHeight: number;
	lineHeight: number;
	topGap: number;
	bottomGap: number;
	text: string;
}

for (const locale of ["zh-CN", "en"] as const) {
	test(`${locale} 推理强度说明按内容留白，切换档位不移动滑块`, async (t) => {
		const port = 9687;
		const custom = locale === "en";
		const label = custom ? "Reasoning effort" : "推理强度";
		const group = `[role="group"][aria-label="${label}"]`;
		const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
		const phase = process.env.PLUME_E2E_PHASE ?? "修改后";
		const app = await startApp({ port, seed: async (home) => {
			const cwd = join(home, "project");
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			await mkdir(cwd, { recursive: true });
			const now = Date.now();
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const meta = { id: "effort-spacing", title: "推理强度间距验证", cwd, projectId, projectName: "推理强度验证", createdAt: now, updatedAt: now, modelId: "qa/model", thinking: custom ? "deep" : "high", messageCount: 2, usage, seq: 4 };
			seedSessions(home, [{ meta, records: [
				{ type: "meta", meta },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "验证推理强度菜单" }], timestamp: now } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "测试会话" }], timestamp: now, api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop" } },
				{ type: "meta", meta },
			] }]);
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 800 }));
			await writeFile(join(home, "settings.json"), JSON.stringify({ uiLocale: locale, thinking: "medium", appearance: { theme: "light" }, mcpServers: [], hooks: [], defaultModelId: "qa/model", projects: [{ id: projectId, path: cwd, name: "推理强度验证", pinned: true, lastOpenedAt: now }], providers: [{ id: "qa", name: "QA", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "test", enabled: true, models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", supportsThinking: true, supportsTools: true, supportsImages: false, contextWindow: 128000, maxOutputTokens: 64000,
				...(custom ? { thinkingOptions: [{ id: "brief", label: "Brief", detail: "Brief reasoning." }, { id: "deep", label: "Deep", detail: "Allow detailed reasoning for difficult investigations and complex refactoring across several modules." }] } : {}),
			}] }] }));
		} });
		const video: Frame[] = [];
		let stop: (() => Promise<void>) | undefined;
		let passed = false;
		try {
			await openSession(app, "effort-spacing");
			if (process.env.PLUME_E2E_ARTIFACTS) stop = await startRecording(port, video);
			for (const width of [1200, 600]) {
				await app.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
				await frames(app, 20);
				await click(app, `main button[aria-label^="${label}"]`);
				await until(app, `document.querySelector(${JSON.stringify(group)})`);
				await focus(app, `${group} input[type="range"]`);
				await press(app, "End", 35);
				await frames(app, 60);
				const before = await measure(app, group);
				await shot(app, `${stamp}_${phase}_${locale}_${width}_初始档位`);
				if (custom) assert.ok(before.descriptionHeight > before.lineHeight * 2, JSON.stringify(before));
				else {
					assert.ok(Math.abs(before.descriptionHeight - before.lineHeight) < 1, JSON.stringify(before));
					assert.ok(Math.abs(before.topGap - before.bottomGap) < 1, JSON.stringify(before));
				}
				await focus(app, `${group} input[type="range"]`);
				await press(app, "Home", 36);
				await until(app, `document.querySelector(${JSON.stringify(group + ' input[type="range"]')}).value === '0'`);
				const samples = await app.evaluate<Geometry[]>(`new Promise(resolve => { const out = []; const f = () => { out.push(${geometry(group)}); if(out.length < 30) requestAnimationFrame(f); else resolve(out); }; requestAnimationFrame(f); })`);
				for (const sample of samples) {
					assert.equal(sample.height, before.height);
					assert.equal(sample.top, before.top);
					assert.equal(sample.sliderY, before.sliderY);
					assert.equal(sample.descriptionHeight, before.descriptionHeight);
				}
				assert.notEqual(samples.at(-1)?.text, before.text);
				await shot(app, `${stamp}_${phase}_${locale}_${width}_最低档位`);
				t.diagnostic(JSON.stringify({ width, before, after: samples.at(-1), stableFrames: samples.length }));
				await press(app, "Escape", 27);
				await until(app, `!document.querySelector(${JSON.stringify(group)})`);
			}
			passed = true;
		} finally {
			await stop?.();
			await app.stop();
			if (video.length && process.env.PLUME_E2E_ARTIFACTS) await encode(video, join(process.env.PLUME_E2E_ARTIFACTS, `${stamp}_${phase}_${locale}_间距与切换_${passed ? "2of2" : "0of2"}.mp4`));
		}
	});
}

function geometry(group: string): string {
	return `(() => {
		const menu = document.querySelector(${JSON.stringify(group)}), p = menu.querySelector('p'), content = p.parentElement;
		const mr = menu.getBoundingClientRect(), pr = p.getBoundingClientRect(), sr = menu.querySelector('input[type="range"]').getBoundingClientRect();
		return { height: mr.height, top: mr.top, sliderY: sr.top, descriptionHeight: pr.height, lineHeight: parseFloat(getComputedStyle(p).lineHeight), topGap: content.firstElementChild.getBoundingClientRect().top - mr.top, bottomGap: mr.bottom - pr.bottom, text: p.querySelector('.ly-roll-value').textContent };
	})()`;
}

function measure(app: RunningApp, group: string): Promise<Geometry> {
	return app.evaluate<Geometry>(geometry(group));
}
