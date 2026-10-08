/**
 * 文生图，用的是人在设置里选的那个图片模型。
 *
 * 和 `web_search` 一样不走授权：它把一句提示词发给人自己配好的供应商，拿回几张图，本机上什么都
 * 不改。用哪个模型、花谁的钱，是人的决定，所以模型只给提示词和尺寸，模型本身随这一轮从设置里带来。
 *
 * 图存进 `session-media`，和会话日志把消息里的图片挪出去时用的是同一个函数、同一个按内容命名的
 * 文件名——日志稍后挪这张图时会落到同一个文件上，不会多存一份。不写进项目目录：人要的可能只是
 * 看一眼，要放进项目时模型拿着结果里的路径自己复制，那一步照常走写文件的授权。
 */

import { errorResult } from "../agent/tool-run.ts";
import { generateImages } from "../ai/images.ts";
import { persistSessionImage, sessionMediaPath } from "../session/payload.ts";
import type { Tool, ToolResult, UserContent } from "../types.ts";
import { MAX_REFERENCES, recentReferences, referencesFromPaths, type ReferenceImage } from "./image-references.ts";

interface ImageArgs {
	prompt: string;
	size?: string;
	images?: string[];
	recent_images?: number;
}

/** 出图慢：gpt-image 的高质量档一张就要一两分钟。 */
const IMAGE_TIMEOUT_MS = 5 * 60_000;
/** 和 `read` 读图片的上限一致：再大，多数对话模型的接口会整条拒掉。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const generateImageTool: Tool<ImageArgs> = {
	name: "generate_image",
	description:
		"Generate an image from a text prompt with the image model the user chose in settings. " +
		"The image is shown to the user right in the conversation and returned to you, along with the path of the saved file; " +
		"copy that file into the project when the user wants the image there. " +
		"Don't link the image or repeat its path in your reply unless the user asks for the file — they are already looking at it. " +
		"Write the prompt as a full description — subject, style, composition, colours, any text to render — in the language that describes it best. " +
		"To edit, restyle or keep the subject of existing images, pass them as references: `images` when every one has a local file path, " +
		"otherwise `recent_images` — the smallest count of the latest images in this conversation (attached by the user, read, or generated) that includes them all. " +
		"Never pass both; leave both out for a brand-new image.",
	parameters: {
		type: "object",
		properties: {
			prompt: { type: "string", description: "What to draw, or what to change in the references." },
			size: { type: "string", description: "Image size the model accepts, e.g. 1024x1024 or 1536x1024. Leave out to use the model's default." },
			images: { type: "array", items: { type: "string" }, description: `Local paths of reference images, at most ${MAX_REFERENCES}.` },
			recent_images: { type: "integer", minimum: 1, maximum: MAX_REFERENCES, description: "Use the latest N images of this conversation as references." },
		},
		required: ["prompt"],
	},
	summarize: (args) => {
		const prompt = typeof args.prompt === "string" ? args.prompt.trim().split("\n")[0] : "";
		return prompt ? `Generate image ${prompt.slice(0, 80)}` : "Generate image";
	},

	async execute(args, ctx): Promise<ToolResult> {
		const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
		if (!prompt) return errorResult("`prompt` is required.");
		const chosen = ctx.imageModel;
		if (!chosen) {
			return errorResult("还没有选择图片生成模型。请用户在「设置 › 智能体 › 图片生成模型」里选一个能出图的模型（比如 gpt-image-1），再重试。");
		}
		if (chosen.provider.api === "anthropic-messages") {
			return errorResult(`「${chosen.model.name}」所在的供应商走 Anthropic 接口，没有出图能力。请在设置里换一个 OpenAI 兼容供应商下的图片模型。`);
		}

		const deadline = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
		const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : undefined;
		const paths = Array.isArray(args.images) ? args.images.filter((path): path is string => typeof path === "string" && path.trim() !== "") : [];
		const recent = typeof args.recent_images === "number" ? Math.floor(args.recent_images) : 0;
		if (paths.length > 0 && recent > 0) return errorResult("`images` 和 `recent_images` 只能给一个。");
		if (paths.length > MAX_REFERENCES || recent > MAX_REFERENCES) return errorResult(`参考图最多 ${MAX_REFERENCES} 张。`);
		let references: ReferenceImage[] = [];
		if (paths.length > 0 || recent > 0) {
			const found = paths.length > 0 ? await referencesFromPaths(paths, ctx) : await recentReferences(recent, ctx);
			if (typeof found === "string") return errorResult(found);
			references = found;
		}
		try {
			const images = await generateImages(chosen.provider, chosen.model, { prompt, size, signal, references });
			const content: UserContent[] = [];
			const saved: string[] = [];
			let oversized = 0;
			for (const image of images) {
				saved.push(sessionMediaPath(persistSessionImage(image.data, image.mimeType)));
				// base64 每 4 个字符 3 个字节。
				if ((image.data.length * 3) / 4 > MAX_IMAGE_BYTES) oversized++;
				else content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}
			const revised = images.map((image) => image.revisedPrompt).filter(Boolean);
			const lines = [
				`用 ${chosen.model.name} ${references.length ? `参考 ${references.length} 张图` : ""}生成了 ${images.length} 张图片，已保存：`,
				...saved,
				...(revised.length ? [`模型改写后的提示词：${revised.join(" / ")}`] : []),
				...(oversized ? [`其中 ${oversized} 张超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，没有附给你看，文件照常保存。`] : []),
				// 不说这句，模型会在回复末尾补一个指向这个路径的「下载原图」链接——图就在它上面。
				"图片已经显示在对话里，回复里不要再附图片链接或路径，除非用户要这个文件。",
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }, ...content],
				details: { kind: "generate_image", model: chosen.model.id, paths: saved, references: references.length },
			};
		} catch (error) {
			if (deadline.aborted && !ctx.signal?.aborted) return errorResult(`出图超时（${IMAGE_TIMEOUT_MS / 60_000} 分钟没有返回）`);
			return errorResult(`出图失败：${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
