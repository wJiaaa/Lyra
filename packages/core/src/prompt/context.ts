/**
 * Sections retain their provenance without storing another copy of the prompt.
 *
 * 来源同时是段落 id：会话内冻结与中途增量按它比对（`update.ts`），`add` 一个新来源就自动纳入，
 * 不用另外接线。同一来源的几块合成一段，所以别给经常变的内容和稳定的内容共用一个来源——变一处，
 * 增量里就要把整段重发一遍（派活说明从 `agents` 里拆成 `delegation` 就是为此）。
 */
export type PromptSource = "identity" | "tools" | "guidelines" | "boundaries" | "environment" | "custom" | "tone" | "userInstructions" | "userMemory" | "projectMemory" | "skills" | "agents" | "delegation" | "projectInstructions" | "workspace" | "resources" | "extension";

export interface PromptSection {
	source: PromptSource;
	start: number;
	end: number;
	path?: string;
	truncated?: boolean;
}

export interface PromptContext {
	systemPrompt: string;
	sections: PromptSection[];
}

export class PromptBuilder {
	private text = "";
	private sections: PromptSection[] = [];

	add(source: PromptSource, content: string, options: Partial<Pick<PromptSection, "path" | "truncated">> = {}): void {
		if (!content) return;
		const start = this.text.length;
		this.text += content;
		this.sections.push({ source, ...options, start, end: this.text.length });
	}

	build(): PromptContext {
		return { systemPrompt: this.text, sections: this.sections.map(section => ({ ...section })) };
	}
}

/** Middleware may append or replace the prompt; never attribute its replacement to old sources. */
export function reconcilePrompt(context: PromptContext, systemPrompt: string): PromptContext {
	if (context.systemPrompt === systemPrompt) return context;
	const keepsPrefix = systemPrompt.startsWith(context.systemPrompt);
	return {
		systemPrompt,
		sections: [
			...(keepsPrefix ? context.sections : []),
			{ source: "extension", start: keepsPrefix ? context.systemPrompt.length : 0, end: systemPrompt.length },
		],
	};
}
