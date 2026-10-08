import { Copy, CornerUpRight, Download, MessageSquarePlus, PanelRightOpen } from "../../ui/icons/index.ts";
import { ContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { MenuItem, MenuSeparator } from "../../ui/overlay/Menu.tsx";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { useDockScope } from "../../app/session-scope.tsx";
import { openFileInScreen } from "../../app/file-opener.ts";
import { useRevealLabel } from "../../store/open-targets.ts";
import { copyImage, imageDataUrl, saveImage } from "../image/index.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

export interface GeneratedImageTarget {
	/** 原图，不是缩略图——复制、下载、带进输入框的都该是画出来的那一张。 */
	src: string;
	/** `session-media` 里落盘的那份。老记录没有，就不给用得着文件的那两项。 */
	path?: string;
}

/** 会话里一张生成图的右键菜单。 */
export function GeneratedImageMenu({ anchor, image, onClose }: { anchor: { x: number; y: number } | null; image: GeneratedImageTarget | null; onClose: () => void }) {
	const { t } = useI18n();
	const reveal = useRevealLabel();
	// 和正文里的本地链接一样，在这张图所在的那块屏幕里开文件面板。
	const screen = useDockScope();
	if (!anchor || !image) return null;

	const openInPane = (path: string) => {
		void openFileInScreen({ path, name: path.split(/[\\/]/).pop() || path }, screen ?? undefined).catch((error: unknown) => useApp.getState().notify(String(error), "error"));
	};

	const addToChat = async () => {
		const parsed = /^data:([^;,]+);base64,(.*)$/s.exec((await imageDataUrl(image.src)) ?? "");
		if (!parsed) return;
		const { activeSessionId, setComposerDraft } = useApp.getState();
		setComposerDraft("", {
			sessionId: activeSessionId,
			attachments: [{ id: `generated-${Date.now()}`, name: image.path?.split(/[\\/]/).pop() ?? "image.png", mimeType: parsed[1]!, kind: "image", data: parsed[2]!, isText: false }],
		});
	};

	return (
		<ContextMenu anchor={anchor} onClose={onClose}>
			{image.path && (
				<MenuItem icon={<PanelRightOpen {...ICON} />} onClick={() => openInPane(image.path!)}>
					{t("imageMenu.openInTab")}
				</MenuItem>
			)}
			<MenuItem icon={<MessageSquarePlus {...ICON} />} onClick={() => void addToChat()}>
				{t("imageMenu.addToChat")}
			</MenuItem>
			<MenuItem icon={<Copy {...ICON} />} onClick={() => void copyImage(image.src)}>
				{t("imageMenu.copy")}
			</MenuItem>
			<MenuSeparator />
			{image.path && (
				<MenuItem icon={<CornerUpRight {...ICON} />} onClick={() => void bridge.system.openIn("reveal", image.path!)}>
					{reveal}
				</MenuItem>
			)}
			<MenuItem icon={<Download {...ICON} />} onClick={() => void saveImage(image.src)}>
				{t("imageMenu.download")}
			</MenuItem>
		</ContextMenu>
	);
}
