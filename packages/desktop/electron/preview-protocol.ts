/**
 * Serving the pages the agent writes.
 *
 * Previews live outside the workspace and are reached over two custom schemes rather than `file://`:
 * `ly-media` for a project's own files, `ly-preview` for generated pages. Both exist so that every
 * read goes through one door with one check — a page asking for `../../../.ssh/id_rsa` gets a 403
 * instead of a key.
 */

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { plumeHome, previewsHome } from "@plume/core";
import { nativeImage, net, protocol, session } from "electron";
import { parseSessionImageUrl, SESSION_IMAGE_HOST, SESSION_MEDIA_HOST } from "../shared/session-image.ts";
import { safeMediaName, sessionMediaHome, sessionMediaPath } from "@plume/core";
import { cachedThumb, parkedThumb } from "./media-thumbs.ts";
import { HEIGHT_MESSAGE, INLINE_KEY, OPEN_MESSAGE, THEME_KEY, THEME_MESSAGE } from "../shared/preview.ts";
import { attachmentFile } from "./attachment-reads.ts";

export const MEDIA_SCHEME = "ly-media";
export const PREVIEW_SCHEME = "ly-preview";
/** Where `preview-inspect.ts` loads pages: a session of its own, in memory, so nothing a page leaves behind outlives the check. */
export const INSPECT_PARTITION = "ly-preview-inspect";

/**
 * The theme the very first painted frame should already be wearing.
 *
 * The renderer cannot work this out in time: the stylesheet ships one palette, and the real one
 * only arrives after `settings:get` resolves — several frames in. So a light-theme app opened
 * dark and then snapped, every launch. The main process has the settings on disk before the
 * window exists, so it hands the answer to the preload, which paints it before the first frame.
 */
/**
 * Tell the OS which appearance this window is in.
 *
 * The platform draws its own surfaces — menus, dialogs, scrollbars, the traffic lights — and picks
 * their appearance from the *window's*, which left alone is whatever the system is set to. A light
 * app on a dark system got dark native chrome around a light page. Nothing in CSS can reach that
 * layer; the window has to be told.
 */
/** Enough of a MIME table for a self-contained page; anything else is served as bytes. */
/**
 * What a themed page starts from: the reply's own type, on no background of its own — the card is
 * transparent, so a page that paints nothing sits on the conversation itself.
 */
const THEMED_BASE =
	"html{color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size,14px);line-height:1.5;-webkit-font-smoothing:antialiased;text-size-adjust:100%}" +
	"body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

/**
 * How tall a page's content is — the measuring the card's height comes from (see the reporter in
 * `withPreviewBridge`). Exported so the check in `preview-inspect.ts` gets the same number: a window
 * asked for its document's height answers with at least the window's own.
 */
export const MEASURE_HEIGHT = `function(){
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

/**
 * Let a preview say how tall it wants to be, wear the app's theme, and hand its links to the app.
 *
 * The card cannot ask: the page is on its own origin inside a sandbox with no same-origin, so
 * nothing in the app can read its layout. The page can volunteer the number, though, and
 * `postMessage` crosses that boundary in the one safe direction — a bare integer, going out.
 *
 * Injected rather than required of the agent, because a page that had to remember to include
 * this would sometimes forget, and the sizing would be right only some of the time.
 */
export function withPreviewBridge(html: string): string {
	/*
	 * Two ways to measure, because either one alone is wrong half the time.
	 *
	 * If the document already scrolls, the content has outgrown the viewport and `scrollHeight` is
	 * exactly the answer. If it does not, the page has been asked how tall it is while filling the
	 * space it was given — `height: 100vh`, a centred grid, a flex column — and it will keep
	 * answering with that space no matter what space we offer.
	 *
	 * For that second case the height rules are lifted and the content is left to compose itself.
	 * That measurement has its own blind spot, which is why it is not used for everything: a page
	 * whose inner boxes are sized in percentages collapses without a height to be a percentage of,
	 * and reports far less than it draws. Restored in the same task, so nothing is ever painted in
	 * the measured state.
	 */
	/*
	 * A classic feedback loop, cut at the source.
	 *
	 * Measure the content, size the card to it, and a page that lands a pixel over its allowance
	 * grows a scrollbar. The scrollbar takes width from the content, the content rewraps and gets
	 * taller, and now it really does overflow — the bar earns its own existence, and every preview
	 * ends up with a grey rail down one side that nothing asked for.
	 *
	 * Removing it from the layout ends the loop: an overlay scrollbar takes no width, so measuring
	 * and displaying agree.
	 *
	 * Hiding the rail was not enough on its own, though. A page left a pixel over its allowance
	 * still scrolls — it wobbles under the wheel, and worse, it swallows the gesture, so scrolling
	 * with the pointer over a preview stops moving the conversation behind it. Inside the card the
	 * page therefore does not scroll at all: it was measured to fit, and anything that genuinely
	 * needs more room has the side panel, where scrolling is what you came for. `ly-inline` is set
	 * by the card and by nothing else, so the same file scrolls normally when opened there.
	 */
	const style = `<style>html.ly-inline,html.ly-inline body{overflow:hidden!important}html{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar{width:0;height:0;display:none}</style><style id="ly-theme"></style>`;
	/*
	 * The theme arrives in the fragment, so it is on the page before the first paint rather than a
	 * frame after it — a dark page that flashed white on every load was the thing to avoid. Written
	 * into a stylesheet at the top of the head, not onto the element, so the page's own `:root` rules
	 * still win. Later changes come by message from the card. The base rules come with the theme and
	 * only with it: a page written before there was a theme expects a white page with black text.
	 *
	 * In the conversation the fragment is dropped once read, so a page's own hash routing never sees
	 * it. In the panel it stays: the page is a browser tab there, and a reload has to find it again.
	 * The panel also has no card behind the page, so there the page paints the background itself.
	 */
	const theme = `var H=location.hash.slice(1).split("&"),inline=false,theme=null;
for(var i=0;i<H.length;i++){if(H[i]===${JSON.stringify(INLINE_KEY)})inline=true;else if(H[i].indexOf(${JSON.stringify(`${THEME_KEY}=`)})===0){try{theme=JSON.parse(decodeURIComponent(H[i].slice(${THEME_KEY.length + 1})))}catch(e){}}}
/* Set before first paint, so the page is never briefly scrollable. */
if(inline&&document.documentElement)document.documentElement.className+=" ly-inline";
var sheet=document.getElementById("ly-theme");
function wear(t){
if(!sheet||!t||typeof t!=="object"||!t.vars||typeof t.vars!=="object")return;
var c=":root{color-scheme:"+(t.scheme==="light"?"light":"dark")+";";
for(var k in t.vars){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.vars[k]).replace(/[;{}<>]/g,"")+";";}
sheet.textContent=c+"}"+${JSON.stringify(THEMED_BASE)}+(parent===window?"html{background:var(--background)}":"");
}
wear(theme);
if(parent!==window&&(inline||theme)){try{history.replaceState(history.state,"",location.pathname+location.search)}catch(e){}}
addEventListener("message",function(e){var d=e.data;if(theme&&e.source===parent&&parent!==window&&d&&typeof d==="object"&&d[${JSON.stringify(THEME_MESSAGE)}])wear(d[${JSON.stringify(THEME_MESSAGE)}]);});`;
	/*
	 * A link that leaves the page goes to the user's browser, by way of the app.
	 *
	 * Left alone it would navigate the frame, and the conversation's frame policy only admits our own
	 * scheme — so the reader clicked a link and the page turned into an error. The sandbox gives the
	 * page no popups, so it cannot open a window itself either; it asks, and the card decides (only
	 * while the reader is actually using it, see `PreviewCard`). Listened for last, so a page that
	 * handles its own links and cancels the click keeps doing that. In the panel the page is the top
	 * document of a browser tab, and links there navigate the tab the way any page's do.
	 */
	const links = `function ask(u){try{parent.postMessage({${JSON.stringify(OPEN_MESSAGE)}:u},"*")}catch(e){}}
if(parent!==window){
addEventListener("click",function(e){
if(!e.isTrusted||e.defaultPrevented||e.button!==0)return;
var p=e.composedPath?e.composedPath():[],a=null;
for(var i=0;i<p.length;i++){var n=p[i];if(n&&n.tagName&&String(n.tagName).toLowerCase()==="a"&&n.hasAttribute&&n.hasAttribute("href")){a=n;break;}}
if(!a)return;
var u;try{u=new URL(a.getAttribute("href"),document.baseURI)}catch(x){return}
if(!/^(https?|mailto):$/.test(u.protocol))return;
e.preventDefault();ask(u.href);
});
window.open=function(u){try{var v=new URL(String(u),document.baseURI);if(/^(https?|mailto):$/.test(v.protocol))ask(v.href)}catch(e){}return null};
}`;
	const script = `<script>(function(){
${theme}
${links}
var last=0;
var measure=${MEASURE_HEIGHT};
function report(){
/* A pixel of slack. Sub-pixel layout rounds up as often as down, and with overflow hidden the
   difference is not a scrollbar any more — it is a clipped row of text. */
var h=measure();if(h)h+=2;
if(h&&Math.abs(h-last)>2){last=h;try{parent.postMessage({${JSON.stringify(HEIGHT_MESSAGE)}:h},"*")}catch(e){}}
}
addEventListener("load",report);addEventListener("resize",report);
if(window.ResizeObserver&&document.documentElement)new ResizeObserver(report).observe(document.documentElement);
setTimeout(report,50);setTimeout(report,200);setTimeout(report,500);setTimeout(report,1200);
})();</script>`;
	// Before the page's own scripts, so a page that never finishes loading still reports.
	// `<head` followed by a space or `>` only: `<header>` is not a head, and injecting into it themes the page a beat late.
	const head = html.match(/<head(?:\s[^>]*)?>/i);
	// A function as the replacement: the tag is the page's own text, and a `$'` or `$&` in it would
	// otherwise be read as a pattern and copy the rest of the document into the attribute.
	if (head) return html.replace(head[0], () => `${head[0]}${style}${script}`);
	// Never ahead of the doctype: anything before it puts the page in quirks mode.
	const doctype = html.match(/^\s*<!doctype[^>]*>/i);
	if (doctype) return html.replace(doctype[0], () => `${doctype[0]}${style}${script}`);
	return style + script + html;
}

function contentTypeFor(path: string): string {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
	return (
		{
			".html": "text/html; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".svg": "image/svg+xml",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
			".avif": "image/avif",
			".bmp": "image/bmp",
			".ico": "image/x-icon",
			/*
			 * The types below are what let a file be *rendered* rather than downloaded.
			 *
			 * Chromium picks its PDF viewer from the content type and nothing else — served as
			 * `application/octet-stream`, an `<embed>` shows a grey box and offers to save the file.
			 * The media types matter for the same reason: `<video>` will not start a stream it has
			 * been told is a byte array, so a `.mkv` played and a `.mov` did not, depending entirely
			 * on how much of the file Chromium was willing to sniff.
			 */
			".pdf": "application/pdf",
			".mp4": "video/mp4",
			".m4v": "video/mp4",
			".webm": "video/webm",
			".mov": "video/quicktime",
			".mkv": "video/x-matroska",
			".mp3": "audio/mpeg",
			".wav": "audio/wav",
			".flac": "audio/flac",
			".ogg": "audio/ogg",
			".m4a": "audio/mp4",
			".aac": "audio/aac",
			".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		}[ext] ?? "application/octet-stream"
	);
}

const THUMB_PNG = { "content-type": "image/png", "cache-control": "private, max-age=31536000" };

/** 缩到这个边长。本来就比它小的原样发回去——放大只会糊，还白存一份。 */
function shrink(bytes: Uint8Array, edge: number): Uint8Array | null {
	const image = nativeImage.createFromBuffer(Buffer.from(bytes));
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const longest = Math.max(width, height);
	if (longest <= edge) return null;
	const scale = edge / longest;
	return image
		.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
		.toPNG();
}

async function serveParkedMedia(url: URL): Promise<Response> {
	const name = safeMediaName(decodeURIComponent(url.pathname.replace(/^\//, "")));
	if (!name) return new Response("not found", { status: 404 });
	const home = sessionMediaHome();
	const thumb = Number(url.searchParams.get("thumb"));
	/*
	 * 命中盘上那份时连原图都不读。
	 *
	 * 原图是几 MB 的字节，读它本身就有代价，而这条路走到底根本用不上它。
	 */
	if (thumb > 0) {
		const cached = await cachedThumb(home, name, thumb);
		if (cached) return new Response(Uint8Array.from(cached), { headers: THUMB_PNG });
		const png = await parkedThumb(home, name, thumb, {
			source: () => readFile(sessionMediaPath(name)).catch(() => null),
			shrink,
		});
		if (png) return new Response(Uint8Array.from(png), { headers: THUMB_PNG });
	}
	const body = await readFile(sessionMediaPath(name)).catch(() => null);
	if (!body) return new Response("not found", { status: 404 });
	const type = name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".webp") ? "image/webp" : "image/png";
	return new Response(Uint8Array.from(body), { headers: { "content-type": type, "cache-control": "private, max-age=31536000" } });
}

async function serveSessionImage(
	url: URL,
	load:
		| ((ref: { projectId: string; sessionId: string; timestamp: number; imageIndex: number }) => Promise<{
				data: string;
				mimeType: string;
		  } | null>)
		| undefined,
): Promise<Response> {
	const parsed = parseSessionImageUrl(url.href);
	if (!parsed || !load || !parsed.projectId || !parsed.sessionId) return new Response("not found", { status: 404 });
	const part = await load(parsed);
	if (!part) return new Response("not found", { status: 404 });
	const bytes = Buffer.from(part.data, "base64");
	if (parsed.thumb) {
		const image = nativeImage.createFromBuffer(bytes);
		if (!image.isEmpty()) {
			const { width, height } = image.getSize();
			const edge = Math.max(width, height);
			if (edge > parsed.thumb) {
				const scale = parsed.thumb / edge;
				const png = image.resize({
					width: Math.max(1, Math.round(width * scale)),
					height: Math.max(1, Math.round(height * scale)),
				}).toPNG();
				return new Response(Uint8Array.from(png), {
					headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000" },
				});
			}
		}
	}
	return new Response(Uint8Array.from(bytes), {
		headers: { "content-type": part.mimeType, "cache-control": "private, max-age=31536000" },
	});
}

/**
 * Register both schemes, on the default session and on the browser panel's partition.
 *
 * `protocol.handle` only ever registers against the session it is called on, and the panel's
 * `<webview>` runs in a partition of its own — which is the point, since a page the agent wrote
 * should not share cookies with anything. The cost is that the partition starts out not knowing the
 * scheme exists, so "open in the side panel" landed on a blank page until it was told.
 */
export function registerPreviewProtocols(options: {
	browserPartition: string;
	resolveMedia(target: string): Promise<string | null>;
	loadSessionImage?(
		ref: { projectId: string; sessionId: string; timestamp: number; imageIndex: number },
	): Promise<{ data: string; mimeType: string } | null>;
}): void {
	const { browserPartition, resolveMedia, loadSessionImage } = options;

	/*
	 * `ly-media://f/<encoded absolute path>`. Decoding it here is the only place it becomes a path
	 * again — and the only place it is checked.
	 *
	 * The check resolves both sides first, which is why it is `resolveReadablePath` rather than the
	 * plain string comparison this used to do. A directory listing hands the renderer canonical
	 * paths, so on macOS an image under a temporary or symlinked project came back as
	 * `/private/var/…` while the configured project path was still `/var/…` — the same directory,
	 * spelled two ways, and the guard read that as "outside the project" and answered 403. Every
	 * picture in a markdown file rendered as its alt text.
	 *
	 * Resolving is also the stricter reading: a symlink inside a project that points out of it
	 * stops being a way through.
	 */
	protocol.handle(MEDIA_SCHEME, async (request) => {
		const url = new URL(request.url);
		if (url.hostname === SESSION_IMAGE_HOST) {
			return serveSessionImage(url, loadSessionImage);
		}
		if (url.hostname === SESSION_MEDIA_HOST) {
			return serveParkedMedia(url);
		}
		const target = decodeURIComponent(url.pathname.replace(/^\//, ""));
		/*
		 * 项目里的，或者某条消息带进来的那一份。后一种是给文件面板用的：消息里点「预览」打开一份项目外的
		 * PDF，面板画它走的就是这里——凭什么放行、只放行到哪儿，见 `attachment-reads.ts`。
		 */
		const allowed = target ? ((await resolveMedia(target)) ?? (await attachmentFile(target))) : null;
		if (!allowed) return new Response("forbidden", { status: 403 });
		return net.fetch(pathToFileURL(allowed).toString(), { headers: request.headers, method: request.method });
	});

	// `ly-preview://<sessionId>/<previewId>/<file>`, resolved against the previews directory.
	const servePreview = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const root = previewsHome(plumeHome());
		const target = resolve(root, url.hostname, decodeURIComponent(url.pathname).replace(/^\//, ""));
		if (target !== root && !target.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
		const body = await readFile(target).catch(() => null);
		if (!body) return new Response("not found", { status: 404 });
		const type = contentTypeFor(target);
		const payload = type.startsWith("text/html") ? withPreviewBridge(body.toString("utf8")) : body;
		return new Response(payload, { headers: { "content-type": type } });
	};

	protocol.handle(PREVIEW_SCHEME, servePreview);
	session.fromPartition(browserPartition).protocol.handle(PREVIEW_SCHEME, servePreview);
	// And on the session the out-of-sight check loads pages in, for the same reason. See `preview-inspect.ts`.
	session.fromPartition(INSPECT_PARTITION).protocol.handle(PREVIEW_SCHEME, servePreview);
}
