/**
 * `plume://<topic>` is Plume's own documentation: one markdown file per topic in `plume-docs/`.
 *
 * The case for it: asked "how do I use /plan" or "which service does web_search use", an agent
 * without this went on to grep the installed `app.asar` nine times, or read the app's source when
 * the session happened to sit in this repository — a dozen calls for an answer one read gives.
 * And for formats this app defines, the alternative is whatever survived in training data, which
 * is a guess with the shape of a fact.
 *
 * Files rather than strings in code, so the docs are edited as docs. They live in the source tree,
 * which is where the CLI and the tests read them; the desktop app bundles core into one file, so
 * its main process ships the directory as an extra resource and points `PLUME_DOCS` at it.
 *
 * The prompt has to say **only read this when the question is about Plume**, or the model will
 * consult it in the middle of unrelated work.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceError, type Completion, type ParsedUrl, type Resource, type ResourceHandler } from "./types.ts";

/** A topic is a filename stem and nothing else, so `plume://../../x` cannot leave the directory. */
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function docsDir(): string {
	return process.env.PLUME_DOCS?.trim() || fileURLToPath(new URL("./plume-docs/", import.meta.url));
}

/** The first `# ` line. The index shows only this, so each file's title says what it answers. */
function titleOf(markdown: string, topic: string): string {
	return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? topic;
}

async function topics(): Promise<string[]> {
	const names = await readdir(docsDir()).catch(() => {
		throw new ResourceError("这份安装没有带上 Plume 的使用说明。");
	});
	return names
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
}

export const plumeResource: ResourceHandler = {
	scheme: "plume",
	/*
	 * Every session's prompt carries this line, so it holds the one restriction that matters:
	 * when to stay away. "Plume itself" is ambiguous in this repository, where the user's task is
	 * often Plume's own code — and there the code is the truth, not the user-facing docs.
	 */
	describe:
		"Plume 这个应用自己的使用说明：命令、设置、权限、扩展、报错。**只在用户问的是 Plume 本身时读**（某个功能怎么用、某项设置在哪、界面上的报错什么意思）；做用户自己的任务、或修改 Plume 源码时都不要读。先 `read plume://` 看有哪些主题",

	async resolve(url: ParsedUrl): Promise<Resource> {
		const topic = url.segments.join("/");
		const known = await topics();
		if (!TOPIC_PATTERN.test(topic) || !known.includes(topic)) {
			throw new ResourceError(`没有“${topic}”这个主题。现有的是：${known.join("、")}`);
		}
		const content = await readFile(join(docsDir(), `${topic}.md`), "utf8");
		return {
			url: url.raw,
			content,
			contentType: "text/markdown",
			immutable: true,
			label: `Plume 文档：${titleOf(content, topic)}（完整）`,
			meta: { topic },
		};
	},

	async list(): Promise<Completion[]> {
		return Promise.all(
			(await topics()).map(async (topic) => ({
				value: `plume://${topic}`,
				description: titleOf(await readFile(join(docsDir(), `${topic}.md`), "utf8"), topic),
			})),
		);
	},
};
