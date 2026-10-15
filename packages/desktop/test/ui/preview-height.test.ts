/**
 * How a preview card settles on a height, given when its page loads and when it speaks.
 *
 * The page inside the card is a frame with a process of its own, and on a busy machine it took
 * longer to start than the card was willing to wait — counted from the card's mount. The card then
 * took its 440 default for an answer: settled, remembered, and from then on only allowed to grow,
 * so the page's real 362 that came a moment later was thrown away. The timing is the window probe's
 * to reproduce (`e2e/preview-height-probe.ts`); these pin the rules, with the clock in hand.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, createElement as h } from "react";
import { PreviewCard, type PreviewInfo } from "../../src/features/files/PreviewCard.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

const PREVIEW: PreviewInfo = { id: "pup1", sessionId: "s1", title: "柴柴小布丁", entry: "index.html" };
const KEY = `ly-preview-height:${PREVIEW.sessionId}/${PREVIEW.id}`;

let view: Mounted | undefined;

beforeEach(() => {
	localStorage.clear();
	mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	mock.timers.reset();
	localStorage.clear();
});

const frame = () => view!.find<HTMLIFrameElement>("iframe");
/** The card's own height, as set on it — what the transcript lays out. */
const height = () => view!.find<HTMLElement>("[data-ly-preview]").style.height;
/** Whether the page is let through to be seen: the frame stays transparent until then. */
const shown = () => frame().className.includes("opacity-100");

// The DOM's own event classes: Node's global `MessageEvent` is undici's, and refuses a window as its source.
const dom = window as unknown as { Event: typeof Event; MessageEvent: typeof MessageEvent };
const tick = (ms: number) => act(async () => mock.timers.tick(ms));
const loaded = () => act(async () => void frame().dispatchEvent(new dom.Event("load")));
const reports = (asked: number) =>
	act(async () => void window.dispatchEvent(new dom.MessageEvent("message", { data: { __dwPreviewHeight: asked }, source: frame().contentWindow })));

async function card(props: { startHeight?: number; preview?: PreviewInfo } = {}): Promise<void> {
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(PreviewCard, { preview: PREVIEW, ...props }) }));
}

test("页面加载之前不算等待：挂上三秒还没加载，加载后的第一次报告照样定高度", async () => {
	await card();
	await tick(3000);
	assert.equal(shown(), false, "nothing to show before the page has loaded");
	assert.equal(localStorage.getItem(KEY), null, "a wait that ran out before the page existed was remembered as its height");

	await loaded();
	await reports(362);
	await tick(400);
	assert.equal(height(), "362px");
	assert.equal(shown(), true);
	assert.equal(localStorage.getItem(KEY), "362");
});

test("加载后一直没有消息，先按默认高度露出来，但不记住；之后来的第一次报告仍可以让卡片变矮", async () => {
	await card();
	await loaded();
	await tick(1500);
	assert.equal(shown(), true, "a page that never reports still has to be seen");
	assert.equal(height(), "440px");
	assert.equal(localStorage.getItem(KEY), null, "the default stood in for a measurement and was remembered as one");

	await reports(362);
	await tick(400);
	assert.equal(height(), "362px", "the late answer could only make the card taller, and the card stayed at 440");
	assert.equal(localStorage.getItem(KEY), "362");
});

test("等待期满时已经收到报告，就等它落定，不先露出默认高度再跳一下", async () => {
	await card();
	await loaded();
	await tick(1300);
	await reports(362);
	await tick(200);
	assert.equal(shown(), false, "shown at 440 for the 200ms before its own answer settled");
	await tick(200);
	assert.equal(height(), "362px");
	assert.equal(shown(), true);
});

test("记住的高度不会被等待超时盖成 440", async () => {
	localStorage.setItem(KEY, "362");
	await card();
	await tick(3000);
	await loaded();
	await tick(1500);
	assert.equal(height(), "362px", "the timeout put its default over the height this preview was measured at");
	assert.equal(localStorage.getItem(KEY), "362");
});

test("草稿交过来的高度同样不被超时盖掉", async () => {
	await card({ startHeight: 300 });
	await loaded();
	await tick(1500);
	assert.equal(height(), "300px", "the timeout put its default over the height the draft handed over");
	assert.equal(localStorage.getItem(KEY), null);
});

test("「重新运行」之后重新量：新页面的报告定下新高度，不会留下一个永远空着的框", async () => {
	await card();
	await loaded();
	await reports(362);
	await tick(400);
	assert.equal(height(), "362px");

	await act(async () => view!.find<HTMLButtonElement>('button[aria-label="重新运行"]').click());
	assert.equal(shown(), false, "a fresh run is measured before it is seen");
	await loaded();
	await reports(300);
	await tick(400);
	assert.equal(height(), "300px", "the new page's first report was taken for a late one from the old, settled survey");
	assert.equal(shown(), true);
});

for (const themed of [false, true]) {
	test(`${themed ? "主题" : "普通"}预览收起后保留网页与自然布局，展开恢复全文高度和焦点`, async () => {
		await card({ preview: { ...PREVIEW, themed } });
		await loaded();
		await reports(1200);
		await tick(400);
		await act(async () => view!.find<HTMLButtonElement>('button[aria-label="展开全部"]').click());
		assert.equal(height(), "1200px");
		const page = frame();
		const src = page.src;
		const toggle = view!.find<HTMLButtonElement>("[data-ly-preview-toggle]");
		toggle.focus();
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		const content = view!.find<HTMLElement>(".ly-reveal");

		await act(async () => toggle.click());
		assert.equal(content.getAttribute("aria-hidden"), "true");
		assert.equal(content.inert, true);
		assert.equal(toggle.getAttribute("aria-expanded"), "false");
		assert.equal(document.activeElement, toggle);
		await reports(1600);
		await tick(400);
		assert.equal(height(), "1600px", "收起时仍保留自然布局，列宽变化后的真实高度也要更新");

		await act(async () => toggle.click());
		assert.equal(content.getAttribute("aria-hidden"), "false");
		assert.equal(content.inert, false);
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		assert.equal(frame(), page, "展开不能重建 iframe");
		assert.equal(frame().src, src, "展开不能导航或重新加载页面");
		assert.equal(height(), "1600px");
		assert.equal(document.activeElement, toggle);
		await act(async () => view!.find<HTMLButtonElement>('button[aria-label="自适应高度"]').click());
		assert.equal(height(), "720px", "整块折叠不能破坏原有的全文展开和缩回");
	});
}

test("没套主题的页面，边框在高度之外：卡片给页面的正好是它要的高度", async () => {
	await card();
	const box = view!.find<HTMLElement>("[data-ly-preview]");
	assert.equal(box.dataset.lyPreview, "card");
	assert.ok(box.className.includes("box-content"), "inside the border, the page got 2px less than it asked for and measured itself short");
});
