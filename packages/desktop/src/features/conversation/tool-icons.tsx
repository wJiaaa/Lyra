import {
	AppWindow,
	Archive,
	Cable,
	Camera,
	FileCode,
	FilePlus,
	FileText,
	FolderTree,
	Globe,
	Image,
	ListTodo,
	Monitor,
	MousePointer2,
	Search,
	Sparkles,
	SquarePen,
	Terminal,
	Users,
} from "../../ui/icons/index.ts";
import { translate } from "../../i18n/translate.ts";
import { safeColour } from "../settings/index.ts";
import type { McpMark } from "./mcp-marks.ts";
import { useMcpMark } from "./useMcpMark.ts";

/*
 * 工具行行首那枚图标，从 `ToolCard` 拆出来：一段几次调用合成的那一行（`WorkStep`）用的是它第一次调用的
 * 图标，和它只有一次调用时那一行是同一枚——从一次长到两次，行首不换。`ToolCard` 经 diff 视图连回转录，
 * 从 `WorkStep` 引它就是一条循环依赖。
 */

const ICONS: Record<string, typeof FileText> = {
	read: FileText,
	write: FilePlus,
	edit: FileCode,
	ls: FolderTree,
	glob: Search,
	grep: Search,
	bash: Terminal,
	bash_output: Terminal,
	todo_write: ListTodo,
	task: Users,
	skill: Sparkles,
	web_fetch: Globe,
	image_generate: Image,
	mcp_search: Search,
	// The sidebar's own marks for a new chat and for archiving, so the row and the place it acts on agree.
	spawn_session: SquarePen,
	archive_session: Archive,
	browser_open: Globe,
	browser_act: MousePointer2,
	browser_tabs: AppWindow,
	browser_viewport: Monitor,
	browser_screenshot: Camera,
};

/**
 * 一个工具的行首图标。
 *
 * `Cable` rather than `Globe` for a server with no icon of its own. The globe was already
 * `web_fetch`'s, so an MCP call and a page fetch drew the same thing — and a globe says "the
 * network", which is true of a hosted server and false of the stdio ones that are most of this
 * catalogue. `Cable` is what 设置 › MCP and the plugins page already use for this, so a row now
 * agrees with the pages the server is managed on.
 */
export function ToolIcon({ name }: { name: string }) {
	const mark = useMcpMark()(name);
	return <ToolMark mark={mark} Icon={ICONS[name] ?? (mark ? Cable : Terminal)} />;
}

/**
 * The mark at the start of a tool row.
 *
 * A glyph for everything built in, and for an MCP call the picture of the server that answered it —
 * because "which server was that" is the question a row of MCP calls has to answer, and the name is
 * already competing with the tool's own name for the same line of text.
 *
 * Drawn at the glyph's size and given no background. A row is 14px of ink beside a sentence; the
 * tile treatment the catalogue uses would make the busiest thing in a transcript the logo of
 * whatever the model happened to call.
 */
function ToolMark({ mark, Icon }: { mark: McpMark | null; Icon: typeof FileText }) {
	const tint = safeColour(mark?.brandColor);

	if (mark?.logo) {
		return <img src={mark.logo} alt="" width={13} height={13} className="shrink-0 rounded-xs object-cover opacity-90" />;
	}

	return (
		<Icon
			size={13}
			strokeWidth={1.8}
			aria-label={mark ? translate("toolCard.mcpServer", { name: mark.name }) : undefined}
			// A server that declared a colour and shipped no picture is still told apart from the next one.
			style={tint ? { color: tint } : undefined}
			className="shrink-0"
		/>
	);
}
