import type { BrowserSelection } from "../shared/browser.ts";
import { browserContents, browserScale } from "./browser-workspace.ts";

const WORLD = 999;
/** One isolated listener owns selection; exiting removes every handler and drawing. */
const INSPECT = `(mode) => new Promise(resolve => {
	globalThis.__plumeCancelInspect?.();
	const layer=document.createElement('div');layer.id='__plume_inspect_layer';
	layer.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none';
	const root=layer.attachShadow({mode:'closed'});
	const box=document.createElement('div'), label=document.createElement('div');
	box.style.cssText='position:fixed;border:2px solid #339cff;background:#339cff18;box-sizing:border-box;border-radius:3px';
	label.style.cssText='position:fixed;max-width:360px;border-radius:7px;padding:5px 8px;background:#1c2634;color:#fff;font:12px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
	root.append(box,label);document.documentElement.append(layer);
	let start=null, current=null, target=null;
	const paint=(r,text)=>{box.style.left=r.x+'px';box.style.top=r.y+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';label.textContent=text;label.style.left=Math.max(0,Math.min(r.x,innerWidth-360))+'px';label.style.top=Math.max(0,r.y-30)+'px';};
	const selector=(el)=>{if(el.id)return '#'+CSS.escape(el.id);const parts=[];let node=el;while(node&&node!==document.body){let part=node.localName;const siblings=node.parentElement?[...node.parentElement.children].filter(e=>e.localName===node.localName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);node=node.parentElement;}return ['body',...parts].join(' > ');};
	const finish=(result)=>{for(const [name,fn] of handlers)document.removeEventListener(name,fn,true);layer.remove();delete globalThis.__plumeCancelInspect;resolve(result);};
	const cancel=()=>finish(null);globalThis.__plumeCancelInspect=cancel;
	const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
	const move=e=>{stop(e);target=document.elementFromPoint(e.clientX,e.clientY);if(!target)return;
		const r=mode==='region'&&start?{x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(start.x-e.clientX),height:Math.abs(start.y-e.clientY)}:target.getBoundingClientRect();
		current={x:r.x,y:r.y,width:r.width,height:r.height};paint(current,(mode==='region'?'框选区域':target.localName+(target.id?'#'+target.id:''))+' · '+Math.round(r.width)+' × '+Math.round(r.height)+' · Esc 退出');};
	const down=e=>{stop(e);start={x:e.clientX,y:e.clientY};};
	const up=e=>{stop(e);if(!target||!current||current.width<2||current.height<2)return;
		const c=getComputedStyle(target),styles={};for(const name of ['display','position','color','background-color','font-family','font-size','line-height','padding','margin','gap','align-items'])styles[name]=c.getPropertyValue(name);
		const r=current;layer.remove();
		finish({url:location.href,title:document.title,selector:selector(target),html:target.outerHTML.slice(0,12000),text:(target.innerText||'').slice(0,6000),styles,bounds:{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,innerWidth-Math.max(0,r.x)),height:Math.min(r.height,innerHeight-Math.max(0,r.y))}});
	};
	const key=e=>{stop(e);if(e.key==='Escape')cancel();};
	const handlers=[['pointermove',move],['pointerdown',down],['pointerup',stop],['click',up],['keydown',key]];
	for(const [name,fn] of handlers)document.addEventListener(name,fn,true);
})`;

export async function cancelBrowserInspect(id: string): Promise<void> {
	await browserContents(id).executeJavaScriptInIsolatedWorld(WORLD, [{ code: "globalThis.__plumeCancelInspect?.()" }]);
}

function selection(value: unknown): value is Omit<BrowserSelection, "screenshot"> {
	if (!value || typeof value !== "object") return false;
	if (!("url" in value) || typeof value.url !== "string" || !("title" in value) || typeof value.title !== "string" || !("selector" in value) || typeof value.selector !== "string" || !("html" in value) || typeof value.html !== "string" || !("text" in value) || typeof value.text !== "string") return false;
	if (!("styles" in value) || !value.styles || typeof value.styles !== "object" || !Object.values(value.styles).every((entry) => typeof entry === "string")) return false;
	if (!("bounds" in value) || !value.bounds || typeof value.bounds !== "object") return false;
	const rect = value.bounds;
	return "x" in rect && typeof rect.x === "number" && "y" in rect && typeof rect.y === "number" && "width" in rect && typeof rect.width === "number" && "height" in rect && typeof rect.height === "number" && Object.values(rect).every(Number.isFinite);
}

export async function inspectBrowser(id: string, mode: "element" | "region"): Promise<BrowserSelection | null> {
	const contents = browserContents(id);
	let cancel: () => void = () => {};
	const interrupted = new Promise<null>((resolve) => { cancel = () => resolve(null); });
	contents.once("destroyed", cancel); contents.once("did-start-navigation", cancel);
	let result: unknown;
	try { result = await Promise.race([interrupted, contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${INSPECT})(${JSON.stringify(mode)})` }])]); }
	finally { contents.removeListener("destroyed", cancel); contents.removeListener("did-start-navigation", cancel); }
	if (result === null) return null;
	if (!selection(result)) throw new Error("页面没有返回有效的元素信息");
	const zoom = contents.getZoomFactor() * browserScale(id);
	const rect = { x: Math.round(result.bounds.x * zoom), y: Math.round(result.bounds.y * zoom), width: Math.max(1, Math.round(result.bounds.width * zoom)), height: Math.max(1, Math.round(result.bounds.height * zoom)) };
	const screenshot = (await contents.capturePage(rect)).toDataURL();
	return { ...result, screenshot };
}
