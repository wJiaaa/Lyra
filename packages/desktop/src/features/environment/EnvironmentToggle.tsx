import { Layers } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { toggleEnvironmentCard, useEnvironmentCard } from "../../store/environment-card.ts";
import { ToolbarButton } from "../../app/window/WindowControls.tsx";

/**
 * 标题栏上开关环境卡片的那颗。
 *
 * 和旁边几颗「只管打开」的面板按钮不同，它是开关，开着就亮：卡片就在按钮正下方，亮着的按钮和
 * 看得见的卡片说的是同一件事。
 */
export function EnvironmentToggle() {
	const { t } = useI18n();
	const open = useEnvironmentCard((state) => state.open);
	return (
		<ToolbarButton label={t("environment.title")} active={open} onClick={toggleEnvironmentCard}>
			<span data-ly-environment-toggle className="flex items-center justify-center">
				<Layers size={13} strokeWidth={1.9} />
			</span>
		</ToolbarButton>
	);
}
