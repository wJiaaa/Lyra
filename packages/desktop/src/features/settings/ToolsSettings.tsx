import { useEffect, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { EmptyHint } from "./controls.tsx";
import { Card, SectionTitle } from "./layout.tsx";

/** Tool inventory. Useful when debugging why the model did or did not have something available. */
export function ToolsSettings() {
	const { t } = useI18n();
	const activeSessionId = useApp((s) => s.activeSessionId);
	// 同 `useFileTree.ts`：`useApp.getState()` 是 zustand store 的静态读法，不是在调 hook。
	// oxlint-disable-next-line react/hooks
	const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(useApp.getState().capabilities);

	useEffect(() => {
		if (!activeSessionId) return;
		void bridge.sessions.capabilities(activeSessionId).then(setCapabilities);
	}, [activeSessionId]);

	const tools = capabilities?.toolNames ?? [];
	const builtin = tools.filter((t) => !t.startsWith("mcp__"));
	const external = tools.filter((t) => t.startsWith("mcp__"));

	return (
		<div className="pt-2">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("settings.tools")}</h1>
			<p className="mt-2 mb-6 text-label text-ink-muted">{t("toolsSettings.intro")}</p>
			<SectionTitle>{t("commandsSettings.builtinTools", { n: builtin.length })}</SectionTitle>
			<Card className="mb-6">
				{builtin.length === 0 ? (
					<EmptyHint>{t("commands.openSessionFirst")}</EmptyHint>
				) : (
					<div className="flex flex-wrap gap-2 p-4">
						{builtin.map((tool) => (
							<span key={tool} className="rounded-lg bg-card px-2.5 py-1 font-mono text-detail text-ink">
								{tool}
							</span>
						))}
					</div>
				)}
			</Card>

			<SectionTitle>{t("commandsSettings.mcpTools", { n: external.length })}</SectionTitle>
			<Card>
				{external.length === 0 ? (
					<EmptyHint>{t("commands.noMcp")}</EmptyHint>
				) : (
					<div className="flex flex-wrap gap-2 p-4">
						{external.map((tool) => (
							<span key={tool} className="rounded-lg bg-card px-2.5 py-1 font-mono text-detail text-ink-muted">
								{tool}
							</span>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}
