/**
 * 这个会话的侧边聊天：一行一个，写的是它问的第一句话，点了在右侧打开。
 *
 * 面板上开着的只是一部分——关掉标签不会删存档以外的东西，有存档没挂出来的也要列，所以先问主进程
 * 有哪些（`sideChat.list`），再把没在手上的拉过来，标题才写得出来。一个都没有时整节不显示：
 * 开新的入口标题栏上已经有一颗，卡片里不为它单独占一行。
 */

import { useEffect, useState } from "react";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { MessageCircle, Plus } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { spokenByPerson } from "../../lib/spoken.ts";
import { useDockScope } from "../../app/session-scope.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { TimeAgo } from "../../ui/primitives/TimeAgo.tsx";
import { openScopedPanel, useSide, type PanelKind } from "../dock/index.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

const kindOf = (sideId: string): PanelKind => (sideId === DEFAULT_SIDE_CHAT_ID ? "chat" : `chat:${sideId}`);

export function SideChatsSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const scope = useDockScope();
	const slots = useSide((state) => state.chats[sessionId]);
	const [listed, setListed] = useState<{ id: string; ids: string[] }>({ id: sessionId, ids: [] });
	// 有话的那几个算数：刚开出来还没开口的面板不是一段侧边聊天。
	const spoken = Object.entries(slots ?? {}).filter(([, slot]) => slot.messages.length > 0).map(([id]) => id);
	const spokenKey = spoken.join(",");

	useEffect(() => {
		let live = true;
		void bridge.sideChat.list(sessionId).then((ids) => {
			if (!live) return;
			setListed({ id: sessionId, ids });
			const inHand = useSide.getState().chats[sessionId] ?? {};
			for (const id of ids) if (!inHand[id]) void useSide.getState().attachChat(sessionId, id);
		}, () => {});
		return () => {
			live = false;
		};
		// 手上有话的那几个变了（新开了一个、关掉了一个）就再问一次存档。
	}, [sessionId, spokenKey]);

	const ids = [...new Set([...(listed.id === sessionId ? listed.ids : []), ...spoken])];
	const rows = ids
		.map((id) => {
			const messages = slots?.[id]?.messages ?? [];
			const first = spokenByPerson(messages).at(-1);
			return { id, title: first?.text.split("\n")[0]?.trim() || t("dock.sideChat"), at: messages.at(-1)?.timestamp };
		})
		.filter((row) => row.at !== undefined);
	if (!rows.length) return null;

	const fresh = () => openScopedPanel(`chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, scope ?? undefined);

	return (
		<Section name="sideChats">
			<SectionLabel action={<IconButton size="xs" label={t("environment.newSideChat")} icon={<Plus size={12} />} onClick={fresh} />}>
				{t("dock.sideChat")}
			</SectionLabel>
			{rows.map((row) => (
				<button key={row.id} type="button" data-ly-environment-side-chat={row.id} className={ROW} onClick={() => openScopedPanel(kindOf(row.id), scope ?? undefined)}>
					<MessageCircle size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<span className="min-w-0 flex-1 truncate">{row.title}</span>
					<TimeAgo iso={new Date(row.at!).toISOString()} className="shrink-0 text-caption text-ink-faint" />
				</button>
			))}
		</Section>
	);
}
