import type { WebContents } from "electron";
import { nativeText } from "./i18n.ts";

/** Automation chrome lives in an isolated world, never in a page's JavaScript globals. */
const WORLD = 999;

export async function evaluatePage(contents: WebContents, code: string, isolated = false): Promise<unknown> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			isolated ? contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) : contents.executeJavaScript(code, true),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(nativeText("browser.unresponsive"))), 15_000); }),
		]);
	} finally { clearTimeout(timer); }
}

/*
 * ref 记在隔离 world 的全局上：页面脚本看不到也改不了，换文档时随旧 world 一起丢掉。
 * 编号由主进程按标签接续，不随文档从 1 重来——否则上一页的 e3 在新页上指向另一个元素，点下去的是别的东西。
 */
const REFS = "const refs = globalThis.plumeRefs ??= { of: new WeakMap(), at: new Map() };";
const INTERACTIVE = "a,button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[contenteditable=''],[contenteditable=true]";
const nextRef = new Map<string, number>();

interface Page { title: string; url: string; text: string; elements: string[] }

/**
 * 页面文字，加上可操作元素各一行：`e7 input:email #mail 邮箱 [value=a@b.c]`。
 *
 * 一行而不是一个对象：120 个元素按对象排版，`"role": null` 这类空字段占了大半。密码框不回显值。
 */
export async function snapshotPage(contents: WebContents, id: string): Promise<Page> {
	const page = await evaluatePage(contents, `(() => { ${REFS}
		let next = ${nextRef.get(id) ?? 1};
		const clean = (value, length) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, length);
		const kind = (el) => el.getAttribute('role') || (el instanceof HTMLInputElement ? 'input:' + el.type : el.tagName === 'A' ? 'link' : el.isContentEditable && !(el instanceof HTMLTextAreaElement) ? 'editable' : el.tagName.toLowerCase());
		const name = (el) => clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt, 80);
		const line = (el, ref) => {
			const parts = [ref, kind(el)];
			if (el.id && el.id.length <= 40) parts.push('#' + el.id);
			const label = name(el); if (label) parts.push(label);
			if (el instanceof HTMLSelectElement) { if (el.selectedOptions[0]) parts.push('[value=' + clean(el.selectedOptions[0].text, 40) + ']'); }
			else if ((el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'password'].includes(el.type)) || el instanceof HTMLTextAreaElement) { if (el.value) parts.push('[value=' + clean(el.value, 40) + ']'); }
			else if (el instanceof HTMLInputElement && el.type === 'password' && el.value) parts.push('[filled]');
			if (el.checked || el.getAttribute('aria-checked') === 'true') parts.push('[checked]');
			if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('[disabled]');
			return parts.join(' ');
		};
		const elements = [];
		for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
			if (elements.length >= 120) break;
			if (!el.getClientRects().length) continue;
			let ref = refs.of.get(el);
			if (!ref) { ref = 'e' + next++; refs.of.set(el, ref); refs.at.set(ref, new WeakRef(el)); }
			elements.push(line(el, ref));
		}
		return { title: document.title, url: location.href, text: (document.querySelector('main,article,[role=main]') || document.body).innerText.slice(0, 40000), elements, next };
	})()`, true) as Page & { next: number };
	nextRef.set(id, page.next);
	return { title: page.title, url: page.url, text: page.text, elements: page.elements };
}

export interface Target { ref?: string; selector?: string }

/**
 * 元素中心点，前提是此刻点得到它：在、看得见、没禁用、不在动、落点上没有别的东西挡着。
 *
 * 不满足就等，最多 3 秒——刚渲染出来、动画还没走完、遮罩正在退场，这些都会自己好。还不满足就说出是哪一条，
 * 尤其是被谁挡住：从前只看找不找得到，点在遮罩上照样报成功，agent 要再读一遍才发现什么都没发生。
 * 落点上的元素是它自己、它里面的、或指向它的 label，都算点得到。「不在动」是隔一帧的时间量两次：在动画里的
 * 元素，算出来的点到按下时已经不在它身上。没有 ref 也没有 selector 时给视口中心，滚动用。
 */
export async function locate(contents: WebContents, target: Target, enabled: boolean): Promise<{ x: number; y: number }> {
	const say = Object.fromEntries((["elementMissing", "refStale", "elementHidden", "elementDisabled", "elementMoving", "elementOffscreen", "elementCovered", "gaveUp"] as const).map((key) => [key, nativeText(`browser.${key}`)]));
	const result: unknown = await evaluatePage(contents, `(async () => { ${REFS}
		const ref = ${JSON.stringify(target.ref ?? null)}, selector = ${JSON.stringify(target.selector ?? null)}, say = ${JSON.stringify(say)};
		if (ref === null && selector === null) return { x: innerWidth / 2, y: innerHeight / 2 };
		const short = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((name) => '.' + name).join('');
		const find = () => {
			if (ref !== null) {
				const el = refs.at.get(ref)?.deref();
				if (!el?.isConnected) throw new Error(say.refStale.replace('{ref}', ref));
				return el;
			}
			const all = [...document.querySelectorAll(selector)];
			return all.find((el) => el.getClientRects().length) ?? all[0];
		};
		const reaches = (el, hit) => {
			for (let node = hit; node; node = node.parentNode ?? node.host) if (node === el) return true;
			return hit.closest('label')?.control === el;
		};
		const deadline = Date.now() + 3000;
		for (;;) {
			let why;
			const el = find();
			if (!el) why = say.elementMissing;
			else if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') why = say.elementHidden;
			else if (${enabled} && (el.matches(':disabled') || el.closest('[aria-disabled="true"]'))) why = say.elementDisabled;
			else {
				el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
				const before = el.getBoundingClientRect();
				await new Promise((resolve) => setTimeout(resolve, 16));
				const r = el.getBoundingClientRect();
				const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
				if (r.x !== before.x || r.y !== before.y || r.width !== before.width || r.height !== before.height) why = say.elementMoving;
				else if (right <= left || bottom <= top) why = say.elementOffscreen;
				else {
					const x = (left + right) / 2, y = (top + bottom) / 2;
					let hit = document.elementFromPoint(x, y);
					while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
					if (!hit || reaches(el, hit)) return { x, y };
					why = say.elementCovered.replace('{by}', short(hit));
				}
			}
			if (Date.now() >= deadline) throw new Error(say.gaveUp.replace('{reason}', why));
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	})()`, true);
	if (!result || typeof result !== "object" || !("x" in result) || !("y" in result) || typeof result.x !== "number" || typeof result.y !== "number" || !Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error(nativeText("browser.noPoint"));
	return { x: result.x, y: result.y };
}

export interface Condition { text?: string; selector?: string; expression?: string; timeout?: number }

const pause = (ms: number) => new Promise<false>((resolve) => { setTimeout(() => resolve(false), ms); });

/**
 * 等页面出现某段文字、某个可见元素，或某个表达式为真。
 *
 * 在主进程里一轮轮问，而不是在页面里等：条件常常要跨一次跳转才成立（提交表单、登录），页面里等的那段脚本
 * 跟着旧文档一起卸掉，再也回不来。每一轮也单独限时，问到正在卸掉的那一页时不至于把整段等待耗在一轮上。
 */
export async function waitPage(contents: WebContents, condition: Condition): Promise<{ waited: number }> {
	const given = (["text", "selector", "expression"] as const).filter((name) => condition[name] !== undefined);
	if (given.length !== 1) throw new Error(nativeText("browser.waitNeedsOne"));
	const timeout = Math.min(Math.max(condition.timeout ?? 10_000, 0), 30_000);
	const probe = condition.text !== undefined
		? () => contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(document.body?.innerText ?? '').includes(${JSON.stringify(condition.text)})` }])
		: condition.selector !== undefined
			? () => contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `[...document.querySelectorAll(${JSON.stringify(condition.selector)})].some((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')` }])
			: () => contents.executeJavaScript(`Promise.resolve(${condition.expression}).then(Boolean)`, true);
	const start = Date.now();
	let failure = "";
	for (;;) {
		const left = start + timeout - Date.now();
		const met = await Promise.race([probe().then((value) => { failure = ""; return value === true; }, (error: unknown) => { failure = error instanceof Error ? error.message : String(error); return false; }), pause(Math.min(1_000, Math.max(left, 0)))]);
		if (met) return { waited: Date.now() - start };
		if (Date.now() - start >= timeout) {
			const facts = { seconds: Math.round(timeout / 1000), url: contents.getURL() };
			throw new Error(failure ? nativeText("browser.waitTimeoutError", { ...facts, error: failure }) : nativeText("browser.waitTimeout", facts));
		}
		await pause(Math.min(200, Math.max(start + timeout - Date.now(), 0)));
	}
}
