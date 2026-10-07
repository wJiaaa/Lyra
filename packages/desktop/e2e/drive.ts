/**
 * 在真窗口里像人一样操作：等、点、打字、按键、开面板、进会话、截图。
 *
 * 这些从前每个用例文件各抄一份，抄着抄着分了叉：有的 `.click()` 一下了事，有的先看落点、等动画停稳。
 * 前者在侧栏收起、弹层还在飘的时候点空了也照样往下走，后面的断言量的就不是这次要量的东西。新写的
 * 用例和一次性的验证脚本都从这里拿；某个文件真有不同的需要（点之前要埋点、按表达式而不是选择器找），
 * 留在那个文件里，并写清楚为什么不用这一份。
 *
 * 参数都是 `Pick<RunningApp, ...>`，所以 `startApp` 给的主窗口和 `app.windows()` 里的面板窗口都能传。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunningApp } from "./app.ts";
import { named, type NamedMode } from "./named.ts";

type Evaluate = Pick<RunningApp, "evaluate">;
type Page = Pick<RunningApp, "evaluate" | "send">;
interface Point { x: number; y: number }

/** 等页面里一个表达式成立。预算按帧算，600 帧在 60Hz 下约 10 秒；超时报的就是这句表达式。 */
export async function until(page: Evaluate, expression: string, budget = 600): Promise<void> {
	await page.evaluate(`new Promise((resolve,reject)=>{let n=${budget};const f=()=>{if(${expression})resolve();else if(--n)requestAnimationFrame(f);else reject(new Error(${JSON.stringify(expression)}));};f();})`);
}

/** 让页面走完 `count` 帧：给刚提交的渲染和过渡起步留出时间。 */
export async function frames(page: Evaluate, count = 20): Promise<void> {
	await page.evaluate(`new Promise(r=>{let n=${count};const f=()=>--n?requestAnimationFrame(f):r();requestAnimationFrame(f);})`);
}

/** 页面里一句找元素的表达式：第一个看得见的匹配项；给了 `name` 就再按人会叫它的名字筛一遍。 */
function finder(selector: string, name?: string, mode: NamedMode = "exact"): string {
	const match = name === undefined ? "" : `&&${named(name, mode)}`;
	return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility({visibilityProperty:true})${match})`;
}

/**
 * 用真鼠标点一下：先把指针移过去，等它停稳、落点确实是它，再按下松开。
 *
 * - 先移指针：行内的操作按钮在指针进入那一行之前是 `pointer-events: none`，不移过去，落点问到的是那一行。
 * - 等停稳：弹层挂载后才量位置、展开有过渡，CDP 的几条消息之间元素还在动，按下去的坐标就是旧的。
 * - 落点不是它就报错，并说出落在了谁身上——侧栏抽屉 `translateX(-100%)` 里的一行在 `checkVisibility`
 *   看来是可见的，按下去什么也没按到；上一条用例没关掉的遮罩也是这样挡住后面每一次点击的。
 */
export async function click(page: Page, selector: string, name?: string, mode: NamedMode = "exact"): Promise<void> {
	const find = finder(selector, name, mode);
	const label = JSON.stringify(name === undefined ? selector : `${selector} "${name}"`);
	await until(page, find);
	const near = await page.evaluate<Point>(`(()=>{const e=${find};e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...near });
	const at = await page.evaluate<Point>(`(async()=>{
		const deadline=performance.now()+8000;let previous='',last='';
		while(true){
			const e=${find};
			if(e){
				const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
				let moving=false;
				for(let a=e;a&&!moving;a=a.parentElement)moving=a.getAnimations().some(n=>Number.isFinite(n.effect?.getComputedTiming().endTime)&&(n.pending||n.playState==='running'));
				const box=[r.x,r.y,r.width,r.height].map(Math.round).join();
				if(!moving&&r.width>0&&r.height>0&&e.contains(hit)&&box===previous)return {x,y};
				previous=box;
				last=moving?'still animating':'at '+Math.round(x)+','+Math.round(y)+' lands on '+(hit?hit.outerHTML.slice(0,160):'nothing');
			}else last='gone';
			if(performance.now()>deadline)throw new Error(${label}+' never settled under the pointer: '+last);
			await new Promise(requestAnimationFrame);
		}
	})()`);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
	await frames(page, 2);
}

/**
 * 往输入框里打字，替换掉原有内容。
 *
 * 走 `Input.insertText` 而不是给 `value` 赋值：受控输入框只认真实的 input 事件，直接赋值界面不动，
 * 而用原型上的 setter 绕过去又跳过了输入法和撤销栈，量到的不是人会遇到的那条路。
 */
export async function type(page: Page, selector: string, text: string): Promise<void> {
	await until(page, finder(selector));
	await page.evaluate(`(()=>{const e=${finder(selector)};e.focus();e.select?.();})()`);
	await page.send("Input.insertText", { text });
	await frames(page, 2);
}

/** 按一个键。回车要带 `text`，否则输入框收到的是 keydown 而没有换行或提交。 */
export async function press(page: Page, key: string, code: number, modifiers = 0): Promise<void> {
	await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, modifiers, ...(key === "Enter" ? { text: "\r" } : {}) });
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
	await frames(page, 2);
}

/** 从工具栏的「面板」菜单打开一个面板。菜单项后面可能跟着快捷键，所以按开头匹配。 */
export async function openPane(page: Page, label: string): Promise<void> {
	await click(page, 'button[aria-label="面板"]');
	await until(page, finder('[role="menuitem"]', label, "starts"));
	if (await page.evaluate<boolean>(`${finder('[role="menuitem"]', label, "starts")}.disabled`)) throw new Error(`${label} is not available on this profile`);
	await click(page, '[role="menuitem"]', label, "starts");
}

/**
 * 在侧栏点开一个会话，等它真的成了当前会话。
 *
 * 点的是行里的那颗按钮，`aria-current` 也挂在它身上，不在 `[data-ly-row]` 那层 div 上：对 div 调
 * `.click()` 不会切换会话，等 `[data-ly-row][aria-current]` 也永远等不到。
 */
export async function openSession(page: Page, id: string): Promise<void> {
	const row = `[data-ly-row="${id}"] > button`;
	await click(page, row);
	await until(page, `document.querySelector(${JSON.stringify(`${row}[aria-current]`)})`);
}

/** 截一张窗口图，只在设了 `PLUME_E2E_ARTIFACTS` 时才写。拍的是这个页面，不是整块屏幕。 */
export async function shot(page: Pick<RunningApp, "send">, name: string): Promise<void> {
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	const image = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(directory, `${name}.png`), Buffer.from(image.data, "base64"));
}
