/**
 * 生图和改图，用的是人配好的生图模型。
 *
 * 和 `web_search` 一样不走授权：它把一段提示词（和要改的图）发给人自己配好的供应商，拿回几张图，
 * 本机上什么都不改。用哪个模型、花谁的钱，是人的决定：默认是设置里那一个（没选就是第一个生图模型），
 * 模型只在人点了名时传 `model`。一个生图模型都没有时，这个工具不进工具表（`prompt-context.ts`）。
 *
 * 走哪个端点、比例和画质怎么跟各家说，在 `images/`；这里只管把对话里的图找出来、把结果存好说清楚。
 *
 * 图存进 `session-media`，和会话日志把消息里的图片挪出去时用的是同一个函数、同一个按内容命名的
 * 文件名——日志稍后挪这张图时会落到同一个文件上，不会多存一份。不写进项目目录：人要的可能只是
 * 看一眼，要放进项目时模型拿着结果里的路径自己复制，那一步照常走写文件的授权。
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { failureOf } from "../ai/failure.ts";
import { resolveImageModel } from "../config/image-models.ts";
import { imageDimensions, sniffImageType } from "../images/dimensions.ts";
import { generateImages } from "../images/generate.ts";
import { conversationPictures, loadPicture, RECENT_IMAGES_KEY } from "../images/recent.ts";
import { ASPECT_RATIOS, QUALITIES } from "../images/shape.ts";
import { IMAGE_TOOL_NAME, type ImageGenerateDetails, type ImageInput, type ImagePointer, type ImageRequest } from "../images/types.ts";
import { persistSessionImage, safeMediaName, sessionMediaHome, sessionMediaPath } from "../session/payload.ts";
import { SessionStore } from "../session/store.ts";
import type { Tool, ToolContext, ToolResult, UserContent } from "../types.ts";
import { displayPath } from "./paths.ts";
import { authorizeRead, toAbsolute } from "./read-access.ts";
import { errorResult } from "./result.ts";

interface ImageArgs {
	prompt: string;
	images?: string[];
	aspect_ratio?: string;
	quality?: string;
	count?: number;
	background?: string;
	model?: string;
}

/** 出图慢：gpt-image 的高质量档一张就要一两分钟，经中转要 4K 的 Gemini 更久。 */
const IMAGE_TIMEOUT_MS = 5 * 60_000;
/**
 * 每张图最多试几次，第一次算在内——固定值，不跟人的重试策略。
 *
 * 那套策略是给对话写的：「网没好就一直等」对一句等着看的回复是对的。出图是一轮里的一次付费调用，
 * 生图模型真正会给的失败是额度用完、几小时后才重置，无限重试会让这一轮一直挂着。重试两次够躲开
 * 一次抖动，再长就该如实报出来。
 */
const IMAGE_ATTEMPTS = 3;
/** 和 `read` 读图片的上限一致：再大，多数对话模型的接口会整条拒掉。 */
const MAX_SHOWN_BYTES = 5 * 1024 * 1024;
/** 编辑接口单张的上限比对话里看图宽，但一张二十兆的图多半是选错了文件。 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUTS = 8;

/** 之前画的图在应用自己的目录里，不在工作区，读它不用问人。 */
function ownMedia(path: string): string | null {
	const rel = relative(sessionMediaHome(), path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return safeMediaName(rel) || null;
}

/**
 * 对话里的图，最新的在前——`#1`、`#2` 指的就是它们。
 *
 * 给的是编号而不是路径，因为人贴进来的图在模型眼里只有像素，没有路径：它看得见那张图，却说不出
 * 那张图在哪。「最新那张」是人指刚贴的图、指刚画的图时共同的说法。
 */
async function picturesOf(ctx: ToolContext): Promise<ImagePointer[]> {
	const messages = await (ctx.transcript?.() ?? new SessionStore().messages(ctx.sessionId)).catch(() => []);
	return conversationPictures(messages, (ctx.state.get(RECENT_IMAGES_KEY) as ImagePointer[] | undefined) ?? []);
}

/**
 * `#1`、`#2` 或路径；第一个取不到的，回一句给模型看的话。
 *
 * 每张输入另外按 `session-media` 名记一份，结果里存成 `sources`，画廊据此画出改图的链路。还不在
 * `session-media` 里的图（工作区文件、小的内联附件）按哈希存进去，文件以后改了，链路的起点照样画得出。
 */
async function inputsFor(refs: string[], ctx: ToolContext): Promise<{ inputs: ImageInput[]; sources: string[] } | string> {
	if (refs.length > MAX_INPUTS) return `At most ${MAX_INPUTS} images can go into one call; ${refs.length} were given.`;
	let pictures: ImagePointer[] | null = null;
	const inputs: ImageInput[] = [];
	const sources: string[] = [];
	for (const raw of refs) {
		const ref = raw.trim();
		const numbered = /^#\s*(\d+)$/.exec(ref);
		if (numbered) {
			pictures ??= await picturesOf(ctx);
			const index = Number(numbered[1]);
			const picture = index >= 1 ? pictures[index - 1] : undefined;
			const loaded = picture ? await loadPicture(picture) : null;
			if (!loaded) {
				return pictures.length === 0
					? `There are no images in this conversation, so "${ref}" refers to nothing. Ask the user to attach the picture.`
					: `"${ref}" is out of range: this conversation has ${pictures.length} image${pictures.length === 1 ? "" : "s"} (#1 is the newest).`;
			}
			inputs.push(loaded);
			sources.push(safeMediaName(picture?.media ?? "") || persistSessionImage(loaded.data, loaded.mimeType));
			continue;
		}
		const absolute = toAbsolute(ctx.cwd, ref);
		const media = ownMedia(absolute);
		if (!media) {
			const access = await authorizeRead(ctx, ref);
			if (!access.ok) return access.message;
		}
		const bytes = await readFile(media ? sessionMediaPath(media) : absolute).catch(() => null);
		if (!bytes) return `Could not read ${ref}.`;
		if (bytes.length > MAX_INPUT_BYTES) return `${ref} is ${Math.round(bytes.length / 1048576)}MB; images over 20MB cannot be sent.`;
		const mimeType = sniffImageType(bytes);
		if (!mimeType) return `${ref} is not a PNG, JPEG or WebP image.`;
		const data = bytes.toString("base64");
		inputs.push({ data, mimeType, name: absolute.split(/[/\\]/).pop() });
		sources.push(media ?? persistSessionImage(data, mimeType));
	}
	return { inputs, sources };
}

function seconds(ms: number): string {
	return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function wait(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.ceil(ms / 1000)} seconds`;
	if (minutes < 60) return `${minutes} minutes`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** 没画成时给模型的那句话，让它能跟人说一件真的事：额度用完了就别再试，key 不让用就去改设置。 */
function failureText(model: string, error: unknown): { text: string; error: NonNullable<ImageGenerateDetails["error"]> } {
	const failure = failureOf(error);
	const full = failure.detail ?? (error instanceof Error ? error.message : String(error));
	const detail = full.slice(0, 600);
	// 记给卡片：额度、密钥这两种它要直接说原因和恢复时间。
	const recorded = { summary: failure.summary, detail: full.slice(0, 2000), hint: failure.hint, retryAfterMs: failure.retryAfterMs };
	if (failure.hint === "check-billing") {
		const when = failure.retryAfterMs ? ` It resets in about ${wait(failure.retryAfterMs)}.` : "";
		return { error: recorded, text: `${model} has no quota left.${when} Tell the user; trying again now will fail the same way.` };
	}
	if (failure.hint === "check-key") {
		return { error: recorded, text: `The provider refused ${model} for this key (${detail.slice(0, 300)}). The user may need to allow the model for the key, or use a provider address whose group includes it. Don't retry.` };
	}
	return { error: recorded, text: `Image generation with ${model} failed: ${failure.summary}. ${detail}` };
}

/**
 * 什么时候画、画完说多少：系统提示的 Guidelines 里说（`prompt/system.ts`），只在这个工具在场时加。
 * 不写进 description——那里讲的是怎么调，这两条是对整段对话的约束。
 */
export const IMAGE_GUIDELINES = [
	"When the user asks for a picture — an illustration, icon, poster, photo, logo, sticker — or asks to change one, use `image_generate`. A chart, diagram or UI that code can draw exactly is better done with code or `preview`.",
	"The picture is shown to the user as it arrives. Afterwards say at most a sentence; don't describe what was drawn unless asked.",
];

export const imageTool: Tool<ImageArgs> = {
	// 写字面量而不是 `IMAGE_TOOL_NAME`：`test/tool-registry.test.ts` 靠读源码找工具名。
	name: "image_generate",
	approvalKind: "network",
	description:
		"Generate images, or edit existing ones, with the image model the user configured, and show them in the conversation.\n\n" +
		"Write `prompt` as a complete brief: subject, composition, setting, style or medium, lighting, colour, and any text that must appear (quoted, verbatim). " +
		"Keep the user's language for text inside the picture. For an edit, say what to change and what must stay the same.\n\n" +
		"To edit or use pictures as reference, list them in `images`: \"#1\" is the newest image in this conversation — something the user attached, or an earlier result — \"#2\" the one before it, and so on. " +
		"A file can be given by path, including the path an earlier result reported.\n\n" +
		"Pass `model` only when the user names an image model.",
	parameters: {
		type: "object",
		properties: {
			prompt: { type: "string", description: "The full brief for the image model." },
			images: {
				type: "array",
				items: { type: "string" },
				description: `Pictures to edit or draw from, at most ${MAX_INPUTS}: "#1" for the newest image in the conversation, "#2" for the one before, or a file path.`,
			},
			aspect_ratio: {
				type: "string",
				enum: ["auto", ...ASPECT_RATIOS],
				description: "Shape of the picture. auto lets the model decide (an edit keeps the input's shape).",
			},
			quality: {
				type: "string",
				enum: ["auto", ...QUALITIES],
				description: "Detail. high and max are slower and cost more; max is the largest the model offers (4K where supported). Default auto.",
			},
			count: { type: "integer", minimum: 1, maximum: 4, description: "How many variations. Default 1." },
			background: {
				type: "string",
				enum: ["auto", "transparent", "opaque"],
				description: "transparent for stickers, icons and logos, where the model supports it.",
			},
			model: { type: "string", description: "Only when the user names an image model, e.g. \"gpt-image-1\"." },
		},
		required: ["prompt"],
		additionalProperties: false,
	},
	mutating: false,
	// 桌面端按「Generate image …」认这张卡（`lib/tool-kinds.ts`），换说法要两边一起改。
	summarize: (args) => {
		const prompt = typeof args.prompt === "string" ? args.prompt.trim().split("\n")[0] : "";
		return prompt ? `Generate image ${prompt.slice(0, 80)}` : "Generate image";
	},

	async execute(args, ctx): Promise<ToolResult> {
		const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
		if (!prompt) return errorResult("`prompt` is required: describe the picture to draw.");
		const asked = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
		const found = resolveImageModel(ctx.imageModels?.providers, ctx.imageModels?.preferred, asked);
		if (!found.row) {
			if (found.reason === "none") return errorResult("No image model is configured. Tell the user to add one in Settings → Models (for example gpt-image-1 or gemini-3.1-flash-image).");
			const names = found.candidates.map((row) => `${row.model.modelId} (${row.provider.name})`).join(", ");
			return errorResult(
				found.reason === "ambiguous"
					? `"${asked}" matches more than one image model: ${names}. Pass one of these exactly.`
					: `No image model called "${asked}" is configured. Available: ${names}. Use one of these, or tell the user to add the model in Settings → Models.`,
			);
		}
		const { provider, model } = found.row;
		if (provider.api === "anthropic-messages") {
			return errorResult(`${model.name} is on a provider that speaks the Anthropic API, which cannot draw. Tell the user to pick an image model under an OpenAI-compatible provider in Settings → Models.`);
		}

		const given = await inputsFor(Array.isArray(args.images) ? args.images.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "") : [], ctx);
		if (typeof given === "string") return errorResult(given);
		const { inputs, sources } = given;

		const ratio = args.aspect_ratio && args.aspect_ratio !== "auto" ? args.aspect_ratio : undefined;
		const quality = (QUALITIES as readonly string[]).includes(args.quality ?? "") ? (args.quality as ImageRequest["quality"]) : undefined;
		const background = args.background === "transparent" || args.background === "opaque" ? args.background : undefined;
		const count = Math.max(1, Math.min(4, Math.round(Number(args.count) || 1)));
		const deadline = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
		const startedAt = Date.now();
		const base: ImageGenerateDetails = {
			kind: IMAGE_TOOL_NAME,
			model: model.id,
			modelName: model.name,
			aspectRatio: ratio,
			quality,
			count,
			edit: inputs.length > 0,
			...(sources.length ? { sources } : {}),
			startedAt,
			...(ratio ? {} : { shapeHint: shapeOf(inputs[0]) }),
		};
		// 图还没有，先把形状和模型交给窗口：画布按形状占位，进度按模型估。
		ctx.onProgress?.({ content: [], details: base });

		let result;
		// 重试只报在等的那一段：等完了把 `retry` 撤掉，卡片回到说阶段，不会一直写着「正在重试」到出图。
		let waited: ReturnType<typeof setTimeout> | undefined;
		try {
			result = await generateImages(provider, model, { prompt, images: inputs, aspectRatio: ratio, quality, count, background }, {
				signal,
				retryAttempts: IMAGE_ATTEMPTS,
				onRetry: (info) => {
					clearTimeout(waited);
					ctx.onProgress?.({ content: [], details: { ...base, retry: { attempt: info.attempt, delayMs: info.delayMs, reason: info.reason } } });
					waited = setTimeout(() => ctx.onProgress?.({ content: [], details: base }), info.delayMs);
				},
			});
		} catch (error) {
			if (ctx.signal?.aborted) throw error;
			const failed = deadline.aborted
				? { text: `Image generation with ${model.name} timed out: no answer in ${IMAGE_TIMEOUT_MS / 60_000} minutes.`, error: { summary: `no answer in ${IMAGE_TIMEOUT_MS / 60_000} minutes` } }
				: failureText(model.name, error);
			return { content: [{ type: "text", text: failed.text }], isError: true, details: { ...base, error: failed.error } satisfies ImageGenerateDetails };
		} finally {
			clearTimeout(waited);
		}

		const saved = result.images.map((image) => {
			const bytes = Buffer.from(image.data, "base64");
			const mimeType = sniffImageType(bytes) ?? image.mimeType;
			return { data: image.data, media: persistSessionImage(image.data, mimeType), mimeType, bytes: bytes.length, ...imageDimensions(bytes) };
		});
		// 最新的在前、排在之前的前面：`#1` 现在是这一轮最后画的那张。
		const drawn = (ctx.state.get(RECENT_IMAGES_KEY) as ImagePointer[] | undefined) ?? [];
		ctx.state.set(RECENT_IMAGES_KEY, [...[...saved].reverse().map(({ media, mimeType }) => ({ media, mimeType })), ...drawn]);

		const paths = saved.map((image) => sessionMediaPath(image.media));
		const shown: UserContent[] = [];
		for (const image of saved) if (image.bytes <= MAX_SHOWN_BYTES) shown.push({ type: "image", data: image.data, mimeType: image.mimeType });
		const oversized = saved.length - shown.length;
		const dims = saved[0]?.width ? ` (${saved[0].width}×${saved[0].height})` : "";
		const lines = [
			`Drew ${saved.length} image${saved.length === 1 ? "" : "s"} with ${model.name}${dims} in ${seconds(Date.now() - startedAt)}; shown to the user in the conversation.`,
			`Saved: ${paths.map((path) => displayPath(ctx.cwd, path)).join(", ")}. To edit one, pass its path — or #1 for the newest image in the conversation — in \`images\`.`,
		];
		if (result.failures?.length) lines.push(`${result.failures.length} of ${count} did not arrive: ${result.failures[0]}.`);
		if (result.revisedPrompt) lines.push(`The provider rewrote the prompt as: ${result.revisedPrompt}`);
		// 不说这句，模型会在回复末尾补一个指向这个路径的「下载原图」链接——图就在它上面。
		lines.push("Don't link the picture or repeat its path in your reply unless the user wants the file — they are already looking at it.");
		if (oversized) lines.push(`${oversized} of them ${oversized === 1 ? "is" : "are"} over ${MAX_SHOWN_BYTES / 1048576}MB and not attached for you to see; the files are saved as usual.`);
		return {
			content: [{ type: "text", text: lines.join("\n") }, ...shown],
			details: {
				...base,
				model: model.id,
				// `paths` 给界面（`ImageCanvas.tsx`、环境卡），`images` 给 `#N`（`images/recent.ts`）。
				paths,
				images: saved.map(({ media, mimeType, width, height }) => ({ media, mimeType, width, height })),
				references: inputs.length,
				route: result.route,
				revisedPrompt: result.revisedPrompt,
				failures: result.failures,
			} satisfies ImageGenerateDetails,
		};
	},
};

/** 输入图的宽高比，从文件头读；没有输入或读不出来就是 undefined。 */
function shapeOf(input: ImageInput | undefined): number | undefined {
	if (!input) return undefined;
	const size = imageDimensions(Buffer.from(input.data, "base64"));
	return size && size.width > 0 && size.height > 0 ? size.width / size.height : undefined;
}
