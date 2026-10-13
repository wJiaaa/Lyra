import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "../types.ts";
import { htmlToText } from "./html-text.ts";
import { assessNetwork } from "./risk-network.ts";
import { createOutputLog } from "./output-log.ts";
import { FRESH_RESULT_MAX_CHARS } from "../agent/prune.ts";

const MAX_BYTES = 2 * 1024 * 1024;
/**
 * 正文上限，压在 `FRESH_RESULT_MAX_CHARS` 以内，与 `bash` 同样留 2000 字符给外壳和截断标记。
 *
 * 超过那条线的新结果会被 `AgedToolPruner` 在模型看到之前剪成前 4k、后 1k：原先的 40,000 只高出
 * 一点，一页 39.6k 的正文到模型那里只剩 5.3k。
 */
const MAX_TEXT = FRESH_RESULT_MAX_CHARS - 2000;
const TRUNCATED = "\n\n… [truncated]";
/** Long enough for any real URL; short enough that a megabyte of query string is not one. */
const MAX_URL_LENGTH = 2048;
/** Redirect hops. Three is generous for `http → https → www → canonical`; a chain longer than that is a loop or a game. */
const MAX_REDIRECTS = 3;
/** Per hop, covering connect, headers and body. */
const HOP_TIMEOUT_MS = 30_000;

interface FetchArgs {
	url: string;
	format?: "text" | "markdown" | "raw";
}

/**
 * Reading a page, without asking permission to read a page.
 *
 * This tool used to open a prompt on every call — the only one in the app that asked before
 * consulting any policy at all, while `bash` at least judged the command first.
 *
 * A GET changes nothing here. It reads bytes into a message; it does not write a file, spawn a
 * process, or touch the project. The blast radius of the act itself is a token budget.
 *
 * The real hazard is what comes back — a page whose text is written to be read as instructions by
 * whatever model fetches it. A prompt showing a URL is no defence at all against that: the content
 * is not on screen when the decision is made. The defence is downstream, where the body is wrapped
 * and labelled as data, and it works whether or not anybody was asked.
 *
 * Public, private and local addresses now follow the same read policy. The destination's
 * address range no longer decides whether the tool may fetch it.
 *
 * What is left is transport hygiene, and it is enforced rather than delegated: http(s) only, no
 * credentials in the URL, bounded length, bounded hops, no cross-origin redirects, every hop
 * resolved once, a content-type allow-list, and a declared charset that has to be real.
 *
 * 连接固定到这一跳解析出的地址（`pinnedLookup`），避免连接时再解析得到不同的目的地。
 * body 流式读、超过上限当场断开，不先读完整个响应再判断大小。
 */
export const webFetchTool: Tool<FetchArgs> = {
	name: "web_fetch",
	approvalKind: "network",
	description:
		"Fetch a URL as readable text. Public, private and local addresses work; a redirect to another origin is refused, so fetch that address yourself.",
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			format: { type: "string", enum: ["text", "markdown", "raw"], description: "Output format. Default text." },
		},
		required: ["url"],
		additionalProperties: false,
	},
	summarize: (args) => `Fetch ${args.url}`,

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.url !== "string" || args.url.trim().length === 0) return errorResult("`url` is required.");
		if (args.url.length > MAX_URL_LENGTH) return errorResult(`URL is longer than ${MAX_URL_LENGTH} characters.`);

		const first = await checkTarget(args.url);
		if ("error" in first) return errorResult(first.error);
		const origin = first.url.origin;

		let current = first.url;
		let addresses = first.addresses;
		let response: IncomingMessage;
		let deadline: AbortSignal;
		// A server that accepts the connection and never answers would otherwise hold the call open
		// until the user presses stop.
		const failure = (error: unknown) =>
			deadline.aborted && !ctx.signal?.aborted
				? `Timed out after ${HOP_TIMEOUT_MS / 1000}s waiting for ${current.href}`
				: error instanceof Error ? error.message : String(error);
		for (let hop = 0; ; hop++) {
			deadline = AbortSignal.timeout(HOP_TIMEOUT_MS);
			try {
				// Handle each hop explicitly so redirects keep the origin and hop limits.
				response = await get(current, addresses, ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline);
			} catch (error) {
				return errorResult(`Request failed: ${failure(error)}`);
			}

			const status = response.statusCode ?? 0;
			const location = status >= 300 && status < 400 ? response.headers.location : undefined;
			if (!location) break;
			response.destroy();
			if (hop >= MAX_REDIRECTS) return errorResult(`Too many redirects (more than ${MAX_REDIRECTS}).`);

			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				return errorResult(`Redirected to an address that cannot be parsed: ${location}`);
			}
			/*
			 * A redirect that leaves the origin is refused rather than followed.
			 *
			 * Whatever was decided about this fetch was decided about *that* origin. Following a
			 * hop to another one would carry the decision somewhere it was never made — and it is
			 * the easy way to turn a fetch of a public page into a fetch of something else. Making
			 * the model ask again for the new address costs one call and keeps the grain of the
			 * decision the same as the grain of the destination.
			 */
			if (next.origin !== origin) {
				return errorResult(
					`Refused a redirect that leaves the original origin (${origin} → ${next.origin}). Fetch ${next.href} explicitly if that is what you want.`,
				);
			}
			const checked = await checkTarget(next.href);
			if ("error" in checked) return errorResult(checked.error);
			current = checked.url;
			addresses = checked.addresses;
		}

		const status = response.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			response.destroy();
			return errorResult(`HTTP ${status} ${response.statusMessage ?? ""} for ${current}`);
		}

		const contentType = response.headers["content-type"] ?? "";
		const kind = classifyContentType(contentType);
		if (!kind) {
			response.destroy();
			// Binary would arrive as replacement characters and spend the turn's budget saying
			// nothing. Refusing names the reason instead.
			return errorResult(`Unsupported content type "${contentType || "(none)"}" — this tool reads text.`);
		}

		let buffer: Buffer;
		try {
			buffer = await readBody(response, MAX_BYTES);
		} catch (error) {
			return errorResult(failure(error));
		}

		let raw: string;
		try {
			raw = decoderFor(contentType).decode(buffer);
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}

		const text = args.format === "raw" || kind === "text" ? raw : htmlToText(raw);
		const open = `<fetched url="${current}" content-type="${contentType}">\n`;
		const close = "\n</fetched>";
		/*
		 * 截掉的部分存进 scratch，告诉模型在哪，和 bash 的完整日志一样。以前截了就扔：一份 130k 字的
		 * 源码只给前 35k，模型只好用 bash 再下一遍，而那 35k 在这一轮之后的每次调用里都带着。
		 * 提示放在 `</fetched>` 外面：外壳里是对方的数据，这句话是工具说的。
		 */
		// 外壳里的 URL 和 content-type 由对方决定长短，重定向后的地址也不受 MAX_URL_LENGTH 约束；
		// 外壳超出那 2000 的余量时从正文里扣，整条结果仍不越线。
		const room = Math.min(MAX_TEXT, FRESH_RESULT_MAX_CHARS - open.length - close.length - TRUNCATED.length);
		const saved = text.length > room ? await saveFull(text, ctx.scratchDir) : undefined;
		const hint = saved ? `\n\n[full text: ${saved} (${text.length} characters) — read or grep it for the part after the cut]` : "";
		const limit = room - hint.length;
		const clipped = text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text;

		return {
			content: [{ type: "text", text: `${open}${clipped}${close}${hint}` }],
			details: { kind: "web_fetch", url: current.toString(), status, bytes: buffer.byteLength, ...(saved ? { outputPath: saved } : {}) },
		};
	},
};

/** 写不进去（没有 scratch、磁盘满）就当没存：结果照样返回，只是少一句提示。 */
async function saveFull(text: string, scratchDir: string | undefined): Promise<string | undefined> {
	try {
		const log = await createOutputLog(scratchDir);
		if (!log) return undefined;
		log.append(text);
		return (await log.close()).outputComplete ? log.path : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Validate the URL, then resolve once so the connection uses this hop's addresses.
 *
 * A resolution failure is not treated as a refusal: the request is about to fail anyway, with a
 * message about DNS that says more than a policy refusal would.
 */
async function checkTarget(input: string): Promise<{ url: URL; addresses: string[] } | { error: string }> {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { error: `Not a valid URL: ${input}` };
	}

	const verdict = assessNetwork({ url: url.href });
	if (verdict.decision === "refuse") return { error: `Refused: ${verdict.reason} (${url.href})` };
	const addresses = await lookup(url.hostname, { all: true })
		.then((entries) => entries.map((entry) => entry.address))
		.catch(() => [] as string[]);

	return { url, addresses };
}

/**
 * 连接只去判定过的地址：请求的 `lookup` 不再问 DNS，直接交回 `checkTarget` 解析出的那一组。
 * 主机名照旧放在请求里，所以 HTTPS 的 SNI、证书校验与 Host 头都还是原域名。字面 IP 不经过
 * `lookup`，它本身就是被判定的那个地址。解析失败时这里是空的，连接照样失败，不会再解析一次。
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
	return (hostname, options, callback) => {
		const entries = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
		const wanted = options.family === 4 || options.family === 6 ? entries.filter((entry) => entry.family === options.family) : entries;
		if (wanted.length === 0) {
			callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 4);
			return;
		}
		if (options.all) (callback as unknown as (error: null, entries: { address: string; family: number }[]) => void)(null, wanted);
		else callback(null, wanted[0].address, wanted[0].family);
	};
}

function get(url: URL, addresses: readonly string[], signal: AbortSignal | undefined): Promise<IncomingMessage> {
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = request(url, {
			method: "GET",
			lookup: pinnedLookup(addresses),
			// 不复用连接池：池里的连接是按主机名找的，可能连着上一次解析出的地址。
			agent: false,
			signal,
			headers: {
				"user-agent": "Plume/0.1 (+https://github.com/wJiaaa/Lyra)",
				accept: "text/html,text/plain,*/*",
				"accept-encoding": "gzip, deflate, br",
			},
		});
		req.once("response", resolve);
		req.once("error", reject);
		req.end();
	});
}

/** 流式读 body，解压后的字节超过上限就断开连接——不先把整个响应读进内存再判断。 */
async function readBody(response: IncomingMessage, limit: number): Promise<Buffer> {
	const tooLarge = () => new Error(`Response is larger than the ${limit / 1024 / 1024} MB limit.`);
	const declared = Number(response.headers["content-length"]);
	const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
	// 声明的长度是压缩后的，只在没压缩时能直接拿来判断。
	if (encoding === "identity" && Number.isFinite(declared) && declared > limit) {
		response.destroy();
		throw tooLarge();
	}
	const decoder =
		encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
	if (!decoder && encoding !== "identity") {
		response.destroy();
		throw new Error(`Unsupported content encoding "${encoding}".`);
	}
	const body: Readable = decoder ? pipeline(response, decoder, () => {}) : response;
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of body) {
			size += (chunk as Buffer).length;
			if (size > limit) throw tooLarge();
			chunks.push(chunk as Buffer);
		}
	} finally {
		if (size > limit || !response.complete) {
			response.destroy();
			body.destroy();
		}
	}
	return Buffer.concat(chunks);
}

/** The body kinds this tool can turn into something a model can read. */
export function classifyContentType(contentType: string): "html" | "text" | undefined {
	const mime = contentType.replace(/;.*$/s, "").trim().toLowerCase();
	if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
	if (mime.startsWith("text/")) return "text";
	if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) {
		return "text";
	}
	// An empty content-type is not a promise of text; treating it as one is how a PNG becomes
	// forty thousand replacement characters.
	return undefined;
}

/**
 * A decoder for whatever the response says it is.
 *
 * A declared charset that `TextDecoder` does not know throws rather than falling back to UTF-8:
 * decoding Shift_JIS as UTF-8 produces a page of replacement characters, and a model reading that
 * will confidently summarise noise. Failing says which charset, which is actionable.
 */
export function decoderFor(contentType: string): InstanceType<typeof TextDecoder> {
	const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim().toLowerCase();
	if (!charset) return new TextDecoder("utf-8");
	try {
		return new TextDecoder(charset);
	} catch {
		throw new Error(`Unsupported charset "${charset}" — refusing rather than returning mojibake.`);
	}
}

export { htmlToText } from "./html-text.ts";
