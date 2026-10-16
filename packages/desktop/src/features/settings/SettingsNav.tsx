/** Settings chapter list. */

import { Scroller } from "../../ui/scroll/Scroller.tsx";
import type { SettingsSection } from "../../store/index.ts";
import type { MessageKey } from "../../i18n/index.ts";
import type { LucideIcon } from "../../ui/icons/index.ts";

type Group = {
	labelKey: MessageKey;
	items: { id: SettingsSection; labelKey: MessageKey; icon: LucideIcon }[];
};

export function SettingsNav({
	groups,
	section,
	compact,
	label,
	onPick,
}: {
	groups: Group[];
	section: SettingsSection;
	compact: boolean;
	label: (key: MessageKey) => string;
	onPick: (id: SettingsSection) => void;
}) {
	return (
		<Scroller className="flex-1" contentClassName={`pb-3 ${compact ? "px-3" : "px-2"}`}>
			<div>
				{/* 字号、间距、配色：分组标题 12px medium 最浅色，条目一律正文色。 */}
				{groups.map((group, index) => (
					<div key={group.labelKey} className={`flex flex-col gap-1 ${index > 0 ? "mt-4" : ""}`}>
						<div className="px-2.5 pb-1 text-caption font-medium text-ink-faint">{label(group.labelKey)}</div>
						{group.items.map((item) => (
							<button
								key={item.id}
								aria-current={section === item.id ? "page" : undefined}
								type="button"
								onClick={() => onPick(item.id)}
								className={`flex w-full items-center gap-2 rounded-xl px-2.5 text-left text-label text-ink ${
									compact ? "h-[40px]" : "h-[32px]"
								} ${section === item.id ? "bg-card-hover" : "hover:bg-card-hover"}`}
							>
								<item.icon size={16} className="shrink-0" />
								{label(item.labelKey)}
							</button>
						))}
					</div>
				))}
			</div>
		</Scroller>
	);
}
