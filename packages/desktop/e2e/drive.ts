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

/**
 * 把 CSS 视口设成 `width`×`height`，等页面真的量到这个尺寸再返回。
 *
 * 断点看的是 `innerWidth`，而 `window.resizeTo` 对普通 Electron 窗口无效，只能走 Emulation。等到量出来
 * 才返回，是因为这一步没生效时后面的断言照样能过：曾有一次窄屏验证报了三条通过，截图里窗口根本没变窄。
 */
export async function resize(page: Page, width: number, height: number): Promise<void> {
	await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await until(page, `innerWidth===${width}&&innerHeight===${height}`);
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
	const at = await settle(page, selector, name, mode);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
	await frames(page, 2);
}

/**
 * 点 iframe 里的一处。框里的文档是另一个源，这一侧选不到里面的元素，只能按框内坐标点：
 * 框本身照 `click` 的规则停稳、确实在指针下，再从它的左上角量 `offset`。
 */
export async function clickInFrame(page: Page, frame: string, offset: Point): Promise<void> {
	await settle(page, frame, undefined, "exact");
	const box = await page.evaluate<Point>(`(()=>{const r=${finder(frame)}.getBoundingClientRect();return {x:r.x,y:r.y};})()`);
	const at = { x: box.x + offset.x, y: box.y + offset.y };
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
	await frames(page, 2);
}

/** 右键：落点规则和 `click` 一样，按的是右键，弹的是应用自己的右键菜单。 */
export async function contextClick(page: Page, selector: string, name?: string, mode: NamedMode = "exact"): Promise<void> {
	const at = await settle(page, selector, name, mode);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "right", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "right", clickCount: 1 });
	await frames(page, 2);
}

/** 长按：落点规则和 `click` 一样，按下后停 `ms` 再松开。手机界面的长按菜单走它。 */
export async function hold(page: Page, selector: string, name?: string, ms = 600, mode: NamedMode = "exact"): Promise<void> {
	const at = await settle(page, selector, name, mode);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
	await new Promise((resolve) => setTimeout(resolve, ms));
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
	await frames(page, 2);
}

/**
 * 等目标出现。按名字找而没等到时，报出这个选择器下实际看得见的名字。
 *
 * 只报「这句表达式没成立」，名字写错了就得再起一次窗口专门把按钮打印出来——有一次验证就因为
 * 猜的「交互验证」其实叫 `project`，多开了一轮 Electron。
 */
async function located(page: Evaluate, selector: string, name: string | undefined, mode: NamedMode): Promise<void> {
	try {
		await until(page, finder(selector, name, mode));
	} catch (error) {
		if (name === undefined) throw error;
		const seen = await page.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility({visibilityProperty:true})).slice(0,20).map(e=>[(e.textContent||"").trim().slice(0,40),e.getAttribute("aria-label")||"",e.dataset.lyTip||""].filter(Boolean).join(" / "))`);
		throw new Error(`${selector} "${name}" never appeared. Visible ${selector}: ${seen.length ? seen.map((one) => JSON.stringify(one)).join(", ") : "none"}`, { cause: error });
	}
}

/** 等目标停稳并确实在指针下，返回按下去的坐标。 */
async function settle(page: Page, selector: string, name: string | undefined, mode: NamedMode): Promise<Point> {
	const find = finder(selector, name, mode);
	const label = JSON.stringify(name === undefined ? selector : `${selector} "${name}"`);
	await located(page, selector, name, mode);
	const near = await page.evaluate<Point>(`(()=>{const e=${find};e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...near });
	return page.evaluate<Point>(`(async()=>{
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
}

/**
 * 只移动真指针，动画用例需要从悬停起步的第一帧开始量。
 *
 * 落点不是它就等它出现在指针下，再原地补一次移动：行内操作按钮要等指针进了那一行才显示，
 * 第一次移动落在行上，按钮出来时指针没动，浏览器不会再发 `pointerenter`。真鼠标会接着动，
 * 这里只动一次，于是悬停动画时有时无。第一次就落对了不等，第一帧照样从起步开始。
 */
export async function hover(page: Page, selector: string, name?: string, mode: NamedMode = "exact"): Promise<void> {
	const find = finder(selector, name, mode);
	const label = JSON.stringify(name === undefined ? selector : `${selector} "${name}"`);
	await located(page, selector, name, mode);
	const at = await page.evaluate<Point>(`(()=>{const r=${find}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	const landed = await page.evaluate<boolean>(`(async()=>{
		const deadline=performance.now()+8000;let first=true;
		while(true){
			const e=${find},hit=document.elementFromPoint(${at.x},${at.y});
			if(e&&e.contains(hit))return first;
			if(performance.now()>deadline)throw new Error(${label}+' never came under the pointer: lands on '+(hit?hit.outerHTML.slice(0,160):'nothing'));
			first=false;
			await new Promise(requestAnimationFrame);
		}
	})()`);
	if (!landed) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
}

/** 为键盘用例放置起始焦点，后续仍用真实 Tab 或方向键移动。 */
export async function focus(page: Evaluate, selector: string, name?: string, mode: NamedMode = "exact"): Promise<void> {
	const find = finder(selector, name, mode);
	await located(page, selector, name, mode);
	await page.evaluate(`${find}.focus()`);
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

/**
 * 接着输入框里已有的字往后打，不替换。
 *
 * 和 `type` 分开：输入框里先有了东西（递进来的附件标记、一段草稿），人接下来是在它后面补一句，
 * 而全选再打会把那枚标记连同附件一起抹掉，量到的就是另一件事。
 */
export async function typeAtEnd(page: Page, selector: string, text: string): Promise<void> {
	await until(page, finder(selector));
	await page.evaluate(`(()=>{const e=${finder(selector)};e.focus();e.setSelectionRange(e.value.length,e.value.length);})()`);
	await frames(page, 2);
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
 * 点面板标签上的 ✕ 关掉这一格，等它的标签从标签条上消失（最后一格要先滑出去）。`kind` 是标签的 `data-panel-tab`。
 *
 * 每一格都画着同一条标签条，没在前台的那几格 `inert` 着、叠在后面，DOM 里却可能排在前面——只找前台那一格的。
 * 等的是标签而不是那一格本身：网页那一格要等主进程把网页关掉才卸下。
 */
export async function closeTab(page: Page, kind: string): Promise<void> {
	const tab = `[data-dock-pane]:not([inert]) [data-panel-tab="${kind}"]`;
	await click(page, `${tab} button:not([role="tab"])`);
	await until(page, `!document.querySelector(${JSON.stringify(tab)})`, 900);
}

/** 弹窗本身的选择器，开出来以后量尺寸、找滑块和帮助按钮都从它往下找。 */
export const EFFORT_MENU = '[role="group"][aria-label="推理强度"]';

/**
 * 点开输入框那一行的推理强度弹窗，等它挂上再走完过渡。`within` 圈定是哪一个输入框：主区是 `main`，
 * 分屏和侧边聊天各有一颗同名按钮。
 *
 * 弹窗底部「新会话默认」那行只在还没有会话时出现，量高度、拍前后对比之前先确认 fixture 落在哪种状态。
 */
export async function openEffortMenu(page: Page, within = "main"): Promise<void> {
	await click(page, `${within} button[aria-label^="推理强度"]`);
	await until(page, `document.querySelector(${JSON.stringify(EFFORT_MENU)})`);
	await frames(page, 60);
}

/** 输入框那一行的模型弹窗。按钮和弹窗都叫「选择模型」，按钮带 `aria-haspopup`，弹窗不带。 */
export const MODEL_MENU = '[role="menu"][aria-label="选择模型"]';

/** 点开输入框那一行的模型弹窗，等它挂上再走完过渡。`within` 同 `openEffortMenu`。 */
export async function openModelMenu(page: Page, within = "main"): Promise<void> {
	await click(page, `${within} button[aria-haspopup="menu"][aria-label="选择模型"]`);
	await until(page, `document.querySelector(${JSON.stringify(MODEL_MENU)})`);
	await frames(page, 60);
}

/** 打开设置并切到某一页（按左侧导航里写的名字，比如「外观」），再等它画完。 */
export async function openSettings(page: Page, section: string): Promise<void> {
	await click(page, "[data-ly-open-settings]");
	await click(page, "nav button", section);
	await frames(page, 20);
}

/** 从设置回到工作区：点左侧导航顶上那颗「返回工作区」。 */
export async function closeSettings(page: Page): Promise<void> {
	await click(page, "nav button", "返回工作区", "starts");
	await frames(page, 20);
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

/** 命令面板的输入框。弹窗本身是它最近的 `[role="dialog"]`。 */
export const COMMAND_PALETTE = '[role="dialog"] input[role="combobox"]';

/** 点侧栏顶上的放大镜，等命令面板开出来、输入框拿到焦点。 */
export async function openCommandPalette(page: Page): Promise<void> {
	await click(page, 'button[aria-label="搜索会话"]');
	await until(page, `document.activeElement?.matches(${JSON.stringify(COMMAND_PALETTE)})`);
	await frames(page, 30);
}

/**
 * 对话里最后一处收起的地方一层层点开（「使用工具」分组 → 工具行 → 卡片），直到 `ready` 成立。
 *
 * 工具调用默认折在分组里，进度、结果图片在点开之前不在 DOM 上。只点调用链的行（`.ly-flow-row`）和
 * 工具卡片的头：输入框那一排的项目、模型菜单也是 `aria-expanded="false"`，而且排在 DOM 最后。
 */
export async function expandLastTurn(page: Page, ready: string, budgetMs = 8000): Promise<void> {
	const end = Date.now() + budgetMs;
	while (!(await page.evaluate<boolean>(`!!(${ready})`))) {
		if (Date.now() > end) throw new Error(`expandLastTurn: ${ready}`);
		const found = await page.evaluate<boolean>(`(()=>{
			document.querySelectorAll('[data-e2e-expand]').forEach(e=>e.removeAttribute('data-e2e-expand'));
			const last=[...document.querySelectorAll('main button.ly-flow-row[aria-expanded="false"], main [data-ly-tool] > button[aria-expanded="false"]')].filter(e=>e.checkVisibility()).at(-1);
			last?.setAttribute('data-e2e-expand','');
			return !!last;
		})()`);
		if (found) await click(page, "[data-e2e-expand]");
		await frames(page, 12);
	}
}

/** 修饰键在 CDP 里的位：Alt 1、Ctrl 2、⌘ 4、Shift 8，可以相加。 */
export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/**
 * 终端里某段字的中心点，用来点它、悬停它。
 *
 * 终端的字不是元素，选择器够不着：按 xterm 画出来的行逐个文本节点找，量的是画面上那几个字的位置，
 * 不是按列数推算——前面有中文时，一个字占两格，推出来的列会错开。
 */
export async function terminalText(page: Evaluate, text: string): Promise<Point> {
	const at = await page.evaluate<Point | null>(`(()=>{
		const want=${JSON.stringify(text)};
		for(const row of document.querySelectorAll('.xterm-rows > div')){
			if(!row.checkVisibility({visibilityProperty:true}))continue;
			const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
			const nodes=[];let all='';
			for(let n;(n=walker.nextNode());){nodes.push([n,all.length]);all+=n.data;}
			const i=all.indexOf(want);if(i<0)continue;
			const range=document.createRange();
			const place=(offset,end)=>{for(const [n,s] of nodes){if(offset<=s+n.data.length&&(offset<s+n.data.length||end)){(end?range.setEnd:range.setStart).call(range,n,offset-s);return;}}};
			place(i,false);place(i+want.length,true);
			const r=range.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;
			// 收在背后的那格也算「可见」，要的是真落在指针下的那一处。
			if(!row.closest('.xterm')?.contains(document.elementFromPoint(x,y)))continue;
			return {x,y};
		}
		return null;
	})()`);
	if (!at) throw new Error(`terminal shows no ${JSON.stringify(text)}`);
	return at;
}

/**
 * 页面里某段字的首尾两点（首字左缘、末字右缘，竖直取行中），用来拖选它。
 *
 * 只在 `within` 里第一个看得见、含着这段字的文本节点里找：要选的是画面上的那几个字，按元素中心
 * 拖，起止点会落在段落的空白处，选下来的是半行别的东西。
 */
export async function textSpan(page: Evaluate, within: string, text: string): Promise<{ start: Point; end: Point }> {
	const span = await page.evaluate<{ start: Point; end: Point } | null>(`(()=>{
		const want=${JSON.stringify(text)};
		for(const root of document.querySelectorAll(${JSON.stringify(within)})){
			if(!root.checkVisibility({visibilityProperty:true}))continue;
			const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
			for(let n;(n=walker.nextNode());){
				const i=n.data.indexOf(want);if(i<0)continue;
				const range=document.createRange();
				range.setStart(n,i);range.setEnd(n,i+1);const a=range.getBoundingClientRect();
				range.setStart(n,i+want.length-1);range.setEnd(n,i+want.length);const b=range.getBoundingClientRect();
				// 滚出视口的那一处 \`checkVisibility\` 也说看得见，要的是真在指针下的。
				if(!root.contains(document.elementFromPoint(a.left+1,a.top+a.height/2)))continue;
				return {start:{x:a.left+1,y:a.top+a.height/2},end:{x:b.right-1,y:b.top+b.height/2}};
			}
		}
		return null;
	})()`);
	if (!span) throw new Error(`${within} shows no ${JSON.stringify(text)}`);
	return span;
}

/** 按下、分几步拖过去、松开——真鼠标划一段字，页面收到的是完整的 mousedown / mousemove / mouseup。 */
export async function dragSelect(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
	for (let i = 1; i <= steps; i++) {
		const at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "left", buttons: 1 });
	}
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
	await frames(page, 4);
}

/** 在一个点上点一下，可以按着修饰键——⌘ 点开终端里的链接就靠它。 */
export async function clickAt(page: Page, at: Point, modifiers = 0): Promise<void> {
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, modifiers });
	await frames(page, 2);
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, modifiers, button: "left", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, modifiers, button: "left", clickCount: 1 });
	await frames(page, 2);
}

/** 在一个点上连点三下选中整段：`clickCount` 递增，浏览器才按段落粒度扩选区。 */
export async function tripleClickAt(page: Page, at: Point): Promise<void> {
	await clicksAt(page, at, 3);
}

/**
 * 在一个点上连点 `times` 下，每两下之间隔 `gapMs`。
 *
 * 人手连点，两下之间有一两百毫秒；页面上「双击之后等不等第三下」这类判断，只有隔开了才量得出来。
 */
export async function clicksAt(page: Page, at: Point, times: number, gapMs = 0): Promise<void> {
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
	for (let count = 1; count <= times; count++) {
		if (count > 1 && gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
		await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: count });
		await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: count });
	}
	await frames(page, 4);
}

/**
 * 把东西拖到一个元素上放下：从访达拖来的文件给 `files`（磁盘上的路径），应用里拖出来的给 `items`。
 *
 * 走 `Input.dispatchDragEvent`，和真拖拽一样经过 dragenter、dragover、drop，页面拿到的是一份真的
 * `DataTransfer`——`webUtils.getPathForFile` 也只认这种来的 `File`。
 */
export async function dropOn(
	page: Page,
	selector: string,
	data: { files?: string[]; items?: { mimeType: string; data: string }[] },
): Promise<void> {
	await until(page, finder(selector));
	const at = await page.evaluate<Point>(`(()=>{const r=${finder(selector)}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	const payload = { items: data.items ?? [], ...(data.files ? { files: data.files } : {}), dragOperationsMask: 1 };
	for (const type of ["dragEnter", "dragOver", "drop"]) {
		await page.send("Input.dispatchDragEvent", { type, ...at, data: payload });
	}
	await frames(page, 2);
}

/**
 * 元素中心那一点，在原生窗口看来是拖窗口的地方还是能点的地方。
 *
 * CDP 发的鼠标事件直接进渲染进程，不经过原生窗口按 `-webkit-app-region` 做的那次判定，所以落在拖拽区
 * 里的按钮用 `click` 照样点得中，而人的鼠标在那儿只会拖动窗口。这里照 Electron 合成拖拽区的办法算：
 * 按文档顺序，`drag` 的矩形并进来，`no-drag` 的矩形挖出去，看最后那一点在不在里面。
 */
export async function dragRegionAt(page: Evaluate, selector: string, name?: string, mode: NamedMode = "exact"): Promise<"drag" | "clickable"> {
	return page.evaluate(`(()=>{
		const target=${finder(selector, name, mode)};
		if(!target) throw new Error("dragRegionAt: nothing matches " + ${JSON.stringify(selector)});
		const box=target.getBoundingClientRect();
		const x=box.x+box.width/2, y=box.y+box.height/2;
		let drag=false;
		for(const el of document.querySelectorAll("*")){
			const region=getComputedStyle(el).getPropertyValue("-webkit-app-region").trim()||getComputedStyle(el).webkitAppRegion;
			if(region!=="drag"&&region!=="no-drag") continue;
			const r=el.getBoundingClientRect();
			if(r.width===0||r.height===0||x<r.left||x>=r.right||y<r.top||y>=r.bottom) continue;
			drag=region==="drag";
		}
		return drag?"drag":"clickable";
	})()`);
}
