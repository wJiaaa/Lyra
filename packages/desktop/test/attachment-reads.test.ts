/**
 * 发出去的消息带着的文件，右边的文件面板打得开——而且只打得开那一个文件。
 *
 * 用户那份 `调研-UI 参考知识库.md` 在桌面上，项目在别处。消息里点「预览」要进文件面板，而面板的每一扇
 * 门从前都只认已打开的项目，于是这一下注定只能得到「无法读取」。放行的规则照抄 core 的
 * `collectAllowedPaths`：只认用户消息里记下的绝对路径，精确到那个文件，只读。
 *
 * 这里对着真的 IPC 处理器和真的 `ly-media` 处理器验，只把 Electron 换成一个空壳：门在不在，要问门本身。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Message } from "@plume/core";

const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const handlers = new Map();
export const protocols = new Map();
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
export const dialog = {};
export const nativeImage = {};
export const net = { fetch: async (url) => new Response("served " + url) };
export const protocol = { handle: (scheme, fn) => protocols.set(scheme, fn) };
export const session = { fromPartition: () => ({ protocol: { handle() {} } }) };
export const getWindow = () => null;
`)}`;
const filesUrl = new URL("../electron/ipc/files.ts", import.meta.url).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: fixtureUrl, shortCircuit: true };
		if (context.parentURL === filesUrl && specifier === "../window.ts") return { url: fixtureUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const fixture: {
	handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
	protocols: Map<string, (request: Request) => Promise<Response>>;
} = await import(fixtureUrl);
const { registerFilesIpc } = await import("../electron/ipc/files.ts");
const { registerPreviewProtocols } = await import("../electron/preview-protocol.ts");
const { attachmentFile, linkedPaths, noteTranscriptFiles } = await import("../electron/attachment-reads.ts");
const { slimSnapshot } = await import("../electron/display-transcript.ts");
const { promptOptions } = await import("../electron/prompt-input.ts");
hooks.deregister();

const root = await mkdtemp(join(tmpdir(), "plume-attachment-reads-"));
const project = join(root, "project");
await mkdir(project);
after(() => rm(root, { recursive: true, force: true }));

registerFilesIpc({ projectRoots: () => [project] });
registerPreviewProtocols({ browserPartition: "test", resolveMedia: async () => null });

/** 桌面上的一份文件，旁边还躺着一份没被带进对话的。 */
async function desktopFile(name: string, text = "# 调研-UI 参考知识库\n\n正文。\n") {
	const dir = await mkdtemp(join(root, "desktop-"));
	const file = join(dir, name);
	await writeFile(file, text);
	await writeFile(join(dir, "secret.txt"), "别人的东西");
	return { dir, file, sibling: join(dir, "secret.txt") };
}

function sent(path: string, extra: Partial<Message> = {}): Message {
	return {
		role: "user",
		content: [{ type: "text", text: "参考的资料是" }],
		timestamp: 1,
		attachments: [{ name: path.split("/").pop() ?? path, kind: "text", mimeType: "text/markdown", path }],
		...extra,
	} as Message;
}

const call = (name: string, ...args: unknown[]) => {
	const handler = fixture.handlers.get(name);
	assert.ok(handler, `${name} 没有注册`);
	return handler({}, ...args);
};

test("消息里记下的附件，面板只读地读得到；它旁边的文件、它所在的目录都读不到", async () => {
	const { dir, file, sibling } = await desktopFile("调研-UI 参考知识库.md");
	assert.equal(await call("files:read", file), null, "记下之前，项目外的文件一律读不到");

	noteTranscriptFiles([sent(file)]);
	const read = (await call("files:read", file)) as { text: string; readOnly: boolean } | null;
	assert.ok(read, "记下之后应当读得到");
	assert.equal(read.text, await readFile(file, "utf8"));
	assert.equal(read.readOnly, true, "项目外的附件只读");

	assert.equal(await call("files:read", sibling), null, "只放行那一个文件");
	assert.equal(await attachmentFile(dir), null, "不放行它所在的目录");
	const listed = (await call("files:list", dir)) as unknown[];
	assert.equal(listed.length, 0, "也列不出那个目录");
	const bytes = (await call("files:bytes", file)) as Uint8Array | null;
	assert.ok(bytes && Buffer.from(bytes).toString("utf8").startsWith("# 调研"), "文档视图走的字节那扇门也认");
});

test("ly-media 那扇门同样只认记下的那一份", async () => {
	const { file, sibling } = await desktopFile("合同.pdf", "%PDF-1.4");
	const media = fixture.protocols.get("ly-media");
	assert.ok(media);
	const get = (path: string) => media(new Request(`ly-media://f/${encodeURIComponent(path)}`));
	assert.equal((await get(file)).status, 403);
	noteTranscriptFiles([sent(file)]);
	const served = await get(file);
	assert.equal(served.status, 200);
	assert.match(await served.text(), /^served file:/);
	assert.equal((await get(sibling)).status, 403);
});

test("只认用户消息里的绝对路径；缺胳膊少腿的转录不抛", async () => {
	const { file } = await desktopFile("a.md");
	const relative = "a.md";
	const holey = [] as Message[];
	holey[3] = sent(file, { role: "assistant" } as Partial<Message>);
	assert.doesNotThrow(() =>
		noteTranscriptFiles([
			...holey,
			{ role: "user", content: [], timestamp: 1 } as Message,
			{ role: "user", content: [], timestamp: 1, attachments: [null, { name: "x" }, { name: "y", path: 7 }, { name: "z", path: relative }] } as unknown as Message,
		]),
	);
	assert.equal(await attachmentFile(file), null, "助手消息里的不算");
	assert.equal(await attachmentFile(relative), null);
});

test("文件被挪走、或者那里换成了目录，就不再放行", async () => {
	const { file } = await desktopFile("b.md");
	noteTranscriptFiles([sent(file)]);
	assert.equal(await attachmentFile(file), await realpath(file));
	await rm(file);
	assert.equal(await attachmentFile(file), null);
	await mkdir(file);
	assert.equal(await attachmentFile(file), null, "目录不交出去，ly-media 会把整个清单递给窗口");
});

test("转录交给窗口的那一刻记下：slimSnapshot 是三条路共同的出口", async () => {
	const { file } = await desktopFile("c.md");
	assert.equal(await attachmentFile(file), null);
	slimSnapshot({ messages: [sent(file)] });
	assert.equal(await attachmentFile(file), await realpath(file));
});

test("新发的消息过门时就记下", async () => {
	const local = await desktopFile("d.md");
	const attachment = (path: string) => ({ attachments: [{ name: "x.md", kind: "text", path }] });

	promptOptions(attachment(local.file));
	assert.equal(await attachmentFile(local.file), await realpath(local.file), "刚发出去的那条，点「预览」要当场打得开");

	// 整批过了校验才记：后面有一项不合法，前面那一项也不留。
	const rejected = await desktopFile("f.md");
	assert.throws(() => promptOptions({ attachments: [{ name: "ok.md", path: rejected.file }, { name: "" }] }));
	assert.equal(await attachmentFile(rejected.file), null);
});

/** 助手的一条回复，正文就是这段 Markdown。 */
function replied(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as Message;
}

test("助手回复里链过去的项目外文件，面板和 ly-media 都打得开；它旁边的文件照旧读不到", async () => {
	// 0b477053 那一轮的原样：验证截图放在桌面上，回复里用 Markdown 链接指过去。
	const { file, sibling } = await desktopFile("2026-10-07-03-22_修改前_1200_缺陷复现.png", "\u0089PNG\u0000");
	assert.equal(await call("files:read", file), null, "记下之前读不到");

	slimSnapshot({ messages: [replied(`已改好。\n\n[修改前截图](${file}) · [别的](https://example.com)`)] });
	const read = (await call("files:read", file)) as { binary?: boolean; readOnly: boolean } | null;
	assert.ok(read, "链过去的那一份读得到");
	assert.equal(read.readOnly, true);
	const media = fixture.protocols.get("ly-media");
	assert.ok(media);
	assert.equal((await media(new Request(`ly-media://f/${encodeURIComponent(file)}`))).status, 200, "图片和视频走的是 ly-media");
	assert.equal(await call("files:read", sibling), null, "只放行链过去的那一个文件");
});

test("链接目标按窗口画链接的认法取：行号、标题、编码、行内代码都认，相对路径和网址不认", () => {
	assert.deepEqual(linkedPaths("[a](/x/a.ts:42) ![图](/x/b.png \"标题\") [c](/x/%E6%B5%8B%E8%AF%95.mp4) [d](/x/e(1).md)"), [
		"/x/a.ts",
		"/x/b.png",
		"/x/测试.mp4",
		"/x/e(1).md",
	]);
	assert.deepEqual(linkedPaths("见 `/x/a.ts:12-30` 和 `src/b.ts`，[相对](docs/c.md)、[网页](https://a.b/c)、[锚点](#d)"), ["/x/a.ts"]);
	assert.deepEqual(linkedPaths("[坏编码](/x/%E0%A4%A.md) [没收口](/x/a.md"), [], "解不开、没收口的都跳过，不抛");
});

test("助手消息里的附件字段、思考块不算；只认它的正文", async () => {
	const { file } = await desktopFile("g.md");
	noteTranscriptFiles([
		{ role: "assistant", content: [{ type: "thinking", thinking: `[g](${file})` }, null], timestamp: 1 } as unknown as Message,
		{ role: "toolResult", content: [{ type: "text", text: `[g](${file})` }], timestamp: 1 } as unknown as Message,
	]);
	assert.equal(await attachmentFile(file), null);
});
