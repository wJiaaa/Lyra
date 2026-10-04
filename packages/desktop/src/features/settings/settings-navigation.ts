import {
	Anchor,
	Archive,
	BarChart3,
	Blocks,
	Bot,
	Camera,
	Database,
	FolderGit2,
	GitPullRequest,
	Globe,
	HardDrive,
	Layers,
	Palette,
	Search,
	Settings2,
	ShieldCheck,
	Smartphone,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import type { SettingsSection } from "../../store/index.ts";
import { groupsFor } from "./sections-for.ts";
import type { MessageKey } from "../../i18n/index.ts";

/*
 * 每一项只有一个名字，就是那个 key。
 *
 * 从前每项还带一个写死的中文 `label`，而它一处都没显示过：分组名画的是 `t(labelKey)`，
 * 项名也是，`label` 只在 `key={group.label}` 里当过 React 的键。也就是说切成英文之后它
 * 仍旧是中文，但那句中文谁也看不见——一个不会被发现是错的错误。键改用 `labelKey`，它本来
 * 就是唯一的。
 */
const GROUPS: { labelKey: MessageKey; items: { id: SettingsSection; labelKey: MessageKey; icon: typeof Settings2 }[] }[] = [
	{
		labelKey: "settings.group.basic",
		items: [
			{ id: "general", labelKey: "settings.general", icon: Settings2 },
			{ id: "appearance", labelKey: "settings.appearance", icon: Palette },
			{ id: "personalization", labelKey: "settings.personalization", icon: Sparkles },
			{ id: "models", labelKey: "settings.models", icon: Layers },
			{ id: "forges", labelKey: "settings.forges", icon: GitPullRequest },
			{ id: "screenshot", labelKey: "settings.screenshot", icon: Camera },
			{ id: "browser", labelKey: "settings.browser", icon: Globe },
		],
	},
	{
		labelKey: "settings.group.agent",
		items: [
			{ id: "plugins", labelKey: "settings.extensions", icon: Blocks },
			{ id: "agents", labelKey: "settings.agents", icon: Bot },
			{ id: "commands", labelKey: "settings.commands", icon: SquareTerminal },
			{ id: "hooks", labelKey: "settings.hooks", icon: Anchor },
			{ id: "search", labelKey: "settings.search", icon: Search },
			{ id: "access", labelKey: "settings.access", icon: ShieldCheck },
		],
	},
	{
		labelKey: "settings.group.data",
		items: [
			{ id: "index", labelKey: "settings.index", icon: Database },
			{ id: "sync", labelKey: "settings.sync", icon: Smartphone },
			{ id: "usage", labelKey: "settings.usage", icon: BarChart3 },
			{ id: "storage", labelKey: "settings.storage", icon: HardDrive },
		],
	},
	{
		labelKey: "settings.group.vcs",
		items: [
			{ id: "worktrees", labelKey: "settings.worktrees", icon: FolderGit2 },
		],
	},
	{
		labelKey: "settings.group.archive",
		items: [
			{ id: "archived", labelKey: "settings.archived", icon: Archive },
		],
	},
];


/** Desktop capture works on every desktop platform; phones still use their native capture. */
export function settingsGroups(_platform: string, phone: boolean) {
	return groupsFor(GROUPS, phone);
}
