/**
 * 这个会话的侧边聊天：一行一个，写的是它问的第一句话，点了在右侧打开。
 *
 * 面板上开着的只是一部分——有记录没挂出来的也要列，所以问主进程这个会话旁边有哪些会话（`attach`），
 * 而不是只看手上的面板。一个都没开过口时整节不显示：开新的入口标题栏上已经有一颗，卡片里不为它
 * 单独占一行。
 */

import { useEffect } from "react";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import type { SessionMeta } from "@plume/core";
import { MessageCircle, Plus } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { useDockScope } from "../../app/session-scope.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { TimeAgo } from "../../ui/primitives/TimeAgo.tsx";
import { openScopedPanel, useSide, type PanelKind } from "../dock/index.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

const kindOf = (sideId: string): PanelKind => (sideId === DEFAULT_SIDE_CHAT_ID ? "chat" : `chat:${sideId}`);
const NONE: Record<string, SessionMeta> = {};

export function SideChatsSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const scope = useDockScope();
	const sides = useSide((state) => state.sides[sessionId] ?? NONE);

	useEffect(() => {
		void useSide.getState().attach(sessionId);
	}, [sessionId]);

	// 有话的那几个算数：先挑了模型、还没开口的那一格不是一段侧边聊天。按开出来的先后排。
	const rows = Object.entries(sides)
		.filter(([, meta]) => meta.messageCount > 0)
		.sort(([, a], [, b]) => a.createdAt - b.createdAt)
		.map(([id, meta]) => ({ id, title: meta.title.trim() || t("dock.sideChat"), at: meta.updatedAt }));
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
					<TimeAgo iso={new Date(row.at).toISOString()} className="shrink-0 text-caption text-ink-faint" />
				</button>
			))}
		</Section>
	);
}
