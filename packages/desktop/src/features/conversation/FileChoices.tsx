/**
 * 回复里只写了文件名，而项目里同名的不止一份：点链接时列出来让人选。
 *
 * 不替人挑（见 `services/locate.ts`），也不退回按工作目录拼——那条路径不存在，点了只会说「读不到」。
 */

import { useI18n } from "../../i18n/index.ts";
import { baseName, dirName, relativeTo } from "../../lib/paths.ts";
import { iconColour, lookFor } from "../../ui/fileIcon.tsx";
import { MenuBody, MenuItem, MenuLabel } from "../../ui/overlay/Menu.tsx";
import { MENU_MAX_HEIGHT, Popover } from "../../ui/overlay/Popover.tsx";

/**
 * Wider than an action menu: rows are directories like `eim-ecom/src/main/java/com/…/handle`, and
 * at 272px the part that tells them apart was cut off. Longer still scrolls, as every menu row does.
 */
const WIDTH = 420;

export function FileChoices({
	anchor,
	paths,
	root,
	onPick,
	onClose,
}: {
	anchor: HTMLElement;
	/** Absolute. */
	paths: readonly string[];
	/** The conversation's project, so each row reads as the part that tells them apart. */
	root: string | null;
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const label = t("markdown.fileChoices", { count: paths.length });
	const look = lookFor(baseName(paths[0] ?? ""), false);
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" align="start" width={WIDTH} maxHeight={MENU_MAX_HEIGHT} role="menu" label={label}>
			<MenuBody>
				<MenuLabel>{label}</MenuLabel>
				{paths.map((path) => {
					// The name is the same on every row and the reply already shows it: the row is where it lives.
					const shown = dirName(root ? relativeTo(root, path) : path);
					return (
						<MenuItem
							key={path}
							icon={<look.Icon size={13} strokeWidth={1.9} style={{ color: iconColour(look) }} />}
							onClick={() => {
								onClose();
								onPick(path);
							}}
						>
							{shown}
						</MenuItem>
					);
				})}
			</MenuBody>
		</Popover>
	);
}
