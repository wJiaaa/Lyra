import { Bell, BookOpen, Bot, Brain, Circle, FileOutput, FoldVertical, MessageCircle, Settings2, ShieldCheck, Sparkles, Terminal, User, type LucideIcon } from "../../../ui/icons/index.ts";
import type { Source } from "@plume/core/trajectory-view";

const icons: Record<Source, LucideIcon> = {
	system: Settings2, context: BookOpen, user: User, thinking: Brain, assistant: MessageCircle,
	"tool-call": Terminal, "tool-result": FileOutput, subagent: Bot, compaction: FoldVertical,
	request: Sparkles, lifecycle: Circle, notice: Bell, approval: ShieldCheck,
};

export function SourceIcon({ source, size = 14 }: { source: Source; size?: number }) {
	const Icon = icons[source];
	return <Icon size={size} strokeWidth={1.7} className="shrink-0" />;
}
