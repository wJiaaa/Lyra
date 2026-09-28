/**
 * 「N 个项目钩子待审核」：输入框上方的一行，对应 ZCode 的工作区钩子待审核提示。
 *
 * 项目钩子可能是别人提交进来的，没信任之前会话里跑到它们只记一笔「已阻止」。不在这里说一声，
 * 人只会觉得自己写的钩子怎么不灵。点「去审核」落到设置页的钩子，那边会直接切到项目那一栏。
 */

import { Anchor, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Button } from "../../ui/primitives/Button.tsx";

/**
 * 忽略过的，按「项目 + 待审的那几条」记，活在这次运行里。
 *
 * 换一批待审的钩子（有人又改了一条），签名跟着变，提示会再出来——忽略的是看过的那一批，不是
 * 以后所有的。
 */
const dismissed = new Set<string>();

export function HookTrustBanner({ className = "" }: { className?: string }) {
	const { t } = useI18n();
	const cwd = useApp((s) => s.workspace?.path) ?? null;
	const [pending, setPending] = useState<{ key: string; count: number } | null>(null);

	const refresh = useCallback(() => {
		if (!cwd) {
			setPending(null);
			return;
		}
		void bridge.hooks
			.list(cwd)
			.then((view) => {
				const waiting = (view.project ?? []).filter((hook) => hook.trusted === false && hook.enabled);
				const key = `${cwd}\n${waiting.map((hook) => `${hook.id}:${hook.command}`).join("\n")}`;
				setPending(waiting.length > 0 ? { key, count: waiting.length } : null);
			})
			// 网页端没有这个接口，读不到就当没有。
			.catch(() => setPending(null));
	}, [cwd]);

	useEffect(refresh, [refresh]);
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	if (!pending || dismissed.has(pending.key)) return null;

	return (
		<div className={className}>
			<div className="mx-auto w-full max-w-[var(--ly-content)]">
				<div className="ly-enter flex w-full items-center gap-2 rounded-lg border border-line-soft bg-card/60 px-2 py-0.5" data-ly-hook-trust-banner="">
					<Anchor size={13} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
					<span className="min-w-0 flex-1 truncate py-1 text-detail text-ink-muted">{t("hooks.pending", { n: pending.count })}</span>
					<Button
						variant="subtle"
						size="xs"
						onClick={() => {
							const state = useApp.getState();
							state.setSettingsSection("hooks");
							state.setView("settings");
						}}
					>
						{t("hooks.review")}
					</Button>
					<IconButton
						size="sm"
						label={t("hooks.dismiss")}
						onClick={() => {
							dismissed.add(pending.key);
							setPending({ ...pending });
						}}
						icon={<X size={12} strokeWidth={2} />}
					/>
				</div>
			</div>
		</div>
	);
}
