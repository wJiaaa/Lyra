/*
 * preview-eval 的检查窗口：照 electron/preview-inspect.ts 的做法，在离屏窗口里载入一页，
 * 回报未捕获异常、其他控制台报错、高度和整页截图（JSON 打到 stdout）。
 *
 *   electron test/tool-eval/preview-inspect.cjs <页面目录> <入口> <宽度> <要不要截图 0|1>
 *
 * 产品里的检查要经 `ly-preview://` 协议和渲染进程交来的主题，这里没有那两样：入口文件旁写一份
 * 加了主题变量和 `plume` 桩的副本再载入。变量值是一套浅色近似，够让 var(--foreground) 有颜色。
 */

const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const [dir, entry, widthText, shotText] = process.argv.slice(-4);
const width = Number(widthText);
const wantShot = shotText === "1";
const LIMIT = 720;
const MAX_SHOT = 2160;

const THEME = `:root{--background:#ffffff;--foreground:#1f1f1f;--muted:#f4f4f5;--muted-foreground:#71717a;--card:#ffffff;--border:#e4e4e7;--primary:#2563eb;--primary-foreground:#ffffff;--success:#16a34a;--warning:#d97706;--danger:#dc2626;--code-background:#f6f8fa;--code-foreground:#24292f;--chart-1:#2563eb;--chart-2:#16a34a;--chart-3:#d97706;--chart-4:#dc2626;--chart-5:#7c3aed;--chart-6:#0891b2;--radius:8px;--font-sans:-apple-system,system-ui,sans-serif;--font-mono:ui-monospace,monospace;color-scheme:light}html{color:var(--foreground);font-family:var(--font-sans)}`;
const STUB = `window.plume={state:null,send:function(){return true},setState:function(v){this.state=v},tweak:function(){var g={slider:function(){return g},color:function(){return g},toggle:function(){return g},select:function(){return g}};return g}};`;

const MEASURE_HEIGHT = `function(){
var b=document.body,d=document.documentElement;
if(!b||!d)return 0;
var scroll=Math.max(b.scrollHeight,d.scrollHeight);
if(scroll>d.clientHeight+2)return scroll;
var keep=[[b,b.style.height,b.style.minHeight],[d,d.style.height,d.style.minHeight]];
b.style.height="auto";b.style.minHeight="0";
d.style.height="auto";d.style.minHeight="0";
var natural=Math.max(b.scrollHeight,b.offsetHeight);
for(var i=0;i<keep.length;i++){keep[i][0].style.height=keep[i][1];keep[i][0].style.minHeight=keep[i][2];}
return natural;
}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.dock?.hide();
app.whenReady().then(async () => {
	const source = readFileSync(join(dir, entry), "utf8");
	const inject = `<style>${THEME}</style><script>${STUB}</script>`;
	const page = /<head[^>]*>/i.test(source) ? source.replace(/<head[^>]*>/i, (head) => head + inject) : inject + source;
	const copy = join(dir, `.inspect-${entry}`);
	writeFileSync(copy, page);
	const win = new BrowserWindow({ show: false, width, height: LIMIT, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, disableDialogs: true, backgroundThrottling: false } });
	const contents = win.webContents;
	let frame = null;
	contents.on("paint", (_e, _d, image) => (frame = image));
	const exceptions = [];
	const errors = [];
	contents.on("console-message", (event) => {
		if (event.level !== "error") return;
		const line = `${event.message.slice(0, 300)} (${entry}:${event.lineNumber})`;
		(event.message.startsWith("Uncaught") ? exceptions : errors).push(line);
	});
	await Promise.race([contents.loadURL(pathToFileURL(copy).href).catch(() => {}), pause(6000)]);
	await pause(700);
	const height = await contents
		// 产品的 MEASURE_HEIGHT（electron/preview-protocol.ts）：那个文件引了 electron 的值，这里没法直接 import。
		.executeJavaScript(`Math.ceil((${MEASURE_HEIGHT})()) + 2`, true)
		.catch(() => undefined);
	const result = { exceptions, errors, ...(typeof height === "number" ? { height, limit: LIMIT } : {}) };
	if (wantShot) {
		const tall = Math.min(Math.max(height ?? LIMIT, 1), MAX_SHOT);
		win.setContentSize(width, tall);
		contents.invalidate();
		const fits = (image) => {
			const size = image.getSize();
			return size.width > 0 && Math.abs((size.height * width) / size.width - tall) <= 2;
		};
		// 帧由 paint 事件换掉，循环里要每次重新取。
		const latest = () => frame;
		for (let waited = 0; !(latest() && fits(latest())) && waited < 2000; waited += 50) await pause(50);
		if (frame && fits(frame)) Object.assign(result, { screenshot: { data: frame.toPNG().toString("base64"), mimeType: "image/png" }, shotHeight: tall });
	}
	rmSync(copy, { force: true });
	process.stdout.write(`${JSON.stringify(result)}\n`);
	win.destroy();
	app.exit(0);
});
