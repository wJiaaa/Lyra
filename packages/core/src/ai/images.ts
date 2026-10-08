/**
 * 文生图：OpenAI 的 `/v1/images/generations`，以及照着它做的那一大批兼容端点。
 *
 * 不是第四条对话链——它不流式、没有工具、没有历史，一问一答拿回几张图。复用的是三条链共用的那
 * 几件小事（拼地址、User-Agent、把失败说成人话），所以 baseUrl 的 `/v1` 规则和对话请求一致：
 * 同一个供应商，聊天能通，出图就打到同一个地址前缀上。
 *
 * 带参考图时走 `/v1/images/edits`（multipart，图片字段用 `image[]`——OpenAI 的多图写法，CLIProxyAPI
 * 也认它）。同一个模型、同一套参数，只是多了几张图。
 *
 * 返回格式各家不一：OpenAI 的 gpt-image 只给 `b64_json`，dall-e 默认给 `url`，硅基流动把列表放在
 * `images` 而不是 `data` 里。这里都收下，统一成 base64；`url` 当场下载，因为那种链接通常一小时
 * 就过期，存一个会失效的地址等于什么都没存。
 */

import { classifyFailure, messageFromBody } from "./failure.ts";
import { joinUrl, USER_AGENT } from "./endpoint.ts";
import type { ModelConfig, ProviderConfig } from "../types.ts";

export interface GeneratedImage {
	/** base64，不带 `data:` 前缀。 */
	data: string;
	mimeType: string;
	/** 有的模型会改写提示词再画，改写后的那句。 */
	revisedPrompt?: string;
}

export interface ImageRequest {
	prompt: string;
	/** 原样转给端点，比如 `1024x1024`、`2K`。不填用模型自己的默认值。 */
	size?: string;
	/** 参考图。有就是改图（`/v1/images/edits`），没有就是文生图。 */
	references?: { data: string; mimeType: string }[];
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export async function generateImages(provider: ProviderConfig, model: ModelConfig, request: ImageRequest): Promise<GeneratedImage[]> {
	const doFetch = request.fetch ?? globalThis.fetch;
	/*
	 * `samplingParams` 先铺、必填项后盖：模型编辑器里填的额外参数（`quality`、`response_format`、
	 * 火山方舟的 `watermark`）是各家出图接口真正不同的地方，开一个口子比在这里认识每一家省事。
	 */
	const fields: Record<string, unknown> = { ...model.samplingParams, model: model.modelId, prompt: request.prompt, ...(request.size ? { size: request.size } : {}) };
	const headers: Record<string, string> = { "user-agent": USER_AGENT, authorization: `Bearer ${provider.apiKey}` };
	const references = request.references ?? [];
	let path = "/v1/images/generations";
	let body: string | FormData;
	if (references.length > 0) {
		path = "/v1/images/edits";
		body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.append(key, typeof value === "string" ? value : JSON.stringify(value));
		for (const [index, image] of references.entries()) {
			const ext = image.mimeType.split("/")[1] ?? "png";
			body.append("image[]", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `reference-${index + 1}.${ext}`);
		}
		// content-type 留给 fetch：multipart 的 boundary 只有它知道。
	} else {
		headers["content-type"] = "application/json";
		body = JSON.stringify(fields);
	}
	const response = await doFetch(joinUrl(provider.baseUrl, path), { method: "POST", headers, body, signal: request.signal });
	const text = await response.text();
	if (!response.ok) {
		const detail = messageFromBody(text);
		const summary = classifyFailure({ from: "status", status: response.status, body: text }).summary;
		throw new Error(`${summary}（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
	}

	let parsed: { data?: unknown; images?: unknown };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new Error(`端点返回的不是 JSON：${text.slice(0, 200)}`);
	}
	const items = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.images) ? parsed.images : [];
	const images: GeneratedImage[] = [];
	for (const item of items as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }[]) {
		const revisedPrompt = typeof item?.revised_prompt === "string" && item.revised_prompt ? item.revised_prompt : undefined;
		if (typeof item?.b64_json === "string" && item.b64_json) {
			const bytes = Buffer.from(item.b64_json, "base64");
			images.push({ data: item.b64_json, mimeType: sniffImageType(bytes) ?? "image/png", revisedPrompt });
		} else if (typeof item?.url === "string" && item.url) {
			images.push({ ...(await download(item.url, doFetch, request.signal)), revisedPrompt });
		}
	}
	if (images.length === 0) throw new Error(`端点没有返回图片：${text.slice(0, 200)}`);
	return images;
}

async function download(url: string, doFetch: typeof globalThis.fetch, signal: AbortSignal | undefined): Promise<GeneratedImage> {
	// 端点有时直接给 data URL 而不是链接。
	const inline = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
	if (inline) return { data: inline[2], mimeType: inline[1] };
	const response = await doFetch(url, { signal });
	if (!response.ok) throw new Error(`下载生成的图片失败（HTTP ${response.status}）`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const header = response.headers.get("content-type")?.split(";")[0].trim();
	return { data: bytes.toString("base64"), mimeType: sniffImageType(bytes) ?? (header?.startsWith("image/") ? header : "image/png") };
}

/** 按文件头认格式。gpt-image 可以要 jpeg/webp，内容和声明对不上时以字节为准。 */
function sniffImageType(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}
