/**
 * MCP 卡片上的登录那一行：远程服务器要 OAuth 时给「登录」，登录过的给「退出登录」。
 *
 * 登录在主进程里等人在浏览器里点完（最多五分钟），按钮这段时间一直转着，说清楚是在等浏览器——
 * 人切到浏览器再切回来，看到的不该是一颗像没反应的按钮。
 */

import { useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";

type Status = AgentCapabilities["mcp"][number];

export function McpSignIn({ serverId, status, onChanged }: { serverId: string; status: Status | undefined; onChanged: () => Promise<void> }) {
	const { t } = useI18n();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const needsLogin = status?.state === "needs-login";
	if (!needsLogin && !status?.signedIn) return null;

	const act = async (call: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>) => {
		setBusy(true);
		setError("");
		const outcome = await call(serverId).catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
		await onChanged();
		setBusy(false);
		if (!outcome.ok) setError(outcome.error);
	};

	return (
		<div className="border-t border-line-soft px-4 py-3" data-mcp-signin={needsLogin ? "needed" : "signed-in"}>
			<div className="flex items-center gap-3">
				<p className="min-w-0 flex-1 text-detail leading-relaxed text-ink-muted">
					{needsLogin ? (busy ? t("mcpSettings.loginWaiting") : t("mcpSettings.loginHint")) : t("mcpSettings.signedIn")}
				</p>
				{needsLogin ? (
					<Button variant="primary" size="sm" loading={busy} onClick={() => void act(bridge.plugins.mcpLogin)}>
						{t("mcpSettings.login")}
					</Button>
				) : (
					<Button variant="subtle" size="sm" loading={busy} onClick={() => void act(bridge.plugins.mcpLogout)}>
						{t("mcpSettings.logout")}
					</Button>
				)}
			</div>
			{error && (
				<p role="alert" className="mt-2 break-words text-detail text-danger">
					{error}
				</p>
			)}
		</div>
	);
}
