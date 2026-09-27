import { Check, Copy, ExternalLink, QrCode, RotateCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import type { WebAccessStatus } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store/index.ts";
import { commitDraft, isLegalDraft } from "../../lib/number-draft.ts";
import { Badge, Card, GhostButton, Row, SectionTitle, TextInput, Toggle } from "./controls.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";

const PORT = { min: 1, max: 65535, step: 1 };

/** Often enough that a browser connecting shows up while you are looking at the page. */
const POLL_MS = 3000;

/**
 * Web access: this desktop's own interface, opened in a browser on the same network.
 *
 * The status lives here rather than in the store because nothing else reads it — it is only worth
 * asking for while this page is open, and polled for the same reason: the number of connected
 * browsers is the one thing on it that changes without anyone touching the page.
 */
export function WebAccessSettings() {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const [status, setStatus] = useState<WebAccessStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [port, setPort] = useState(String(settings?.webAccess.port ?? 4517));
	const [copied, setCopied] = useState<string | null>(null);
	const [shown, setShown] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void bridge.web.status().then(setStatus, () => {});
	}, []);

	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	// The field follows the stored value when it changes elsewhere.
	useEffect(() => setPort(String(settings?.webAccess.port ?? 4517)), [settings?.webAccess.port]);

	const act = (work: () => Promise<WebAccessStatus>) => {
		setBusy(true);
		void work()
			.then(setStatus, () => refresh())
			.finally(() => setBusy(false));
	};

	if (!settings) return null;

	const running = status?.running ?? false;
	const urls = status?.urls ?? [];
	const qr = shown && urls.includes(shown) ? shown : null;

	const commitPort = () => {
		const parsed = commitDraft(port, PORT);
		if (parsed === null) {
			setPort(String(settings.webAccess.port));
			return;
		}
		setPort(String(parsed));
		if (parsed === settings.webAccess.port) return;
		// A running service keeps the port it was started on; restarting is what moves it.
		act(async () => {
			await saveSettings({ ...settings, webAccess: { ...settings.webAccess, port: parsed } });
			return running ? bridge.web.start() : bridge.web.status();
		});
	};

	const copy = (url: string) => {
		void navigator.clipboard.writeText(url);
		setCopied(url);
		setTimeout(() => setCopied((current) => (current === url ? null : current)), 1500);
	};

	return (
		<div className="pt-2">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("webAccess.title")}</h1>
			<p className="mt-2 max-w-[600px] pb-7 text-label leading-relaxed text-ink-muted">{t("webAccess.intro")}</p>

			<SectionTitle>{t("webAccess.service")}</SectionTitle>
			<Card className="mb-6">
				<Row
					title={t("webAccess.enable")}
					detail={t("webAccess.enableDetail")}
					control={
						<Toggle
							checked={running}
							ariaLabel={t("webAccess.enable")}
							onChange={(on) => {
								if (!busy) act(() => (on ? bridge.web.start() : bridge.web.stop()));
							}}
						/>
					}
				/>
				<Row
					title={t("webAccess.status")}
					detail={
						status?.error
							? t("webAccess.failed", { reason: status.error })
							: running
								? t("webAccess.clients", { count: status?.clients ?? 0 })
								: t("webAccess.notRunning")
					}
					control={
						<Badge tone={status?.error ? "danger" : running ? "ok" : "muted"}>
							{running ? t("webAccess.running") : t("webAccess.stopped")}
						</Badge>
					}
				/>
				<Row
					title={t("webAccess.port")}
					control={
						<TextInput
							value={port}
							onChange={(next) => {
								if (isLegalDraft(next, PORT)) setPort(next);
							}}
							mono
							inputMode="numeric"
							className="w-[120px]"
							onBlur={commitPort}
						/>
					}
				/>
			</Card>

			<SectionTitle>{t("webAccess.links")}</SectionTitle>
			<Card className="mb-3">
				{!running ? (
					<div className="px-4 py-10 text-center text-label text-ink-faint">{t("webAccess.enableFirst")}</div>
				) : urls.length === 0 ? (
					<div className="px-4 py-10 text-center text-label text-ink-faint">{t("webAccess.noAddress")}</div>
				) : (
					<div className="divide-y divide-line-soft">
						{urls.map((url) => (
							<div key={url} className="flex items-center gap-2 px-4 py-3">
								<code className="min-w-0 flex-1 truncate font-mono text-detail text-ink">{url}</code>
								<LinkAction label={copied === url ? t("common.copied") : t("common.copy")} onClick={() => copy(url)}>
									{copied === url ? <Check size={14} strokeWidth={2} className="text-ok" /> : <Copy size={14} strokeWidth={1.8} />}
								</LinkAction>
								<LinkAction label={t("webAccess.qr")} active={qr === url} onClick={() => setShown(qr === url ? null : url)}>
									<QrCode size={14} strokeWidth={1.8} />
								</LinkAction>
								<LinkAction label={t("webAccess.open")} onClick={() => void bridge.system.openExternal(url)}>
									<ExternalLink size={14} strokeWidth={1.8} />
								</LinkAction>
							</div>
						))}
						{qr && (
							<div className="flex flex-col items-center gap-2.5 px-4 py-5">
								{/*
								 * White, always, and padded: a QR code is read as dark on light, and drawn in the
								 * app's own palette many phone cameras will not lock onto it. The quiet zone is
								 * part of the specification rather than styling.
								 */}
								<div className="rounded-2xl bg-white p-4">
									<QRCodeSVG value={qr} size={200} level="M" marginSize={0} />
								</div>
								<div className="text-detail text-ink-faint">{t("webAccess.scan")}</div>
							</div>
						)}
					</div>
				)}
			</Card>
			<p className="mb-6 max-w-[600px] text-detail leading-relaxed text-ink-faint">{t("webAccess.warning")}</p>

			<SectionTitle>{t("webAccess.token")}</SectionTitle>
			<Card>
				<Row
					title={t("webAccess.rotate")}
					detail={t("webAccess.rotateDetail")}
					control={
						<GhostButton
							icon={<RotateCw size={13} strokeWidth={1.8} />}
							disabled={busy}
							onClick={() => act(() => bridge.web.rotateToken())}
						>
							{t("webAccess.rotateAction")}
						</GhostButton>
					}
				/>
			</Card>
		</div>
	);
}

function LinkAction({
	label,
	active = false,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-label={label}
			aria-pressed={active || undefined}
			onClick={onClick}
			className={`grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover ${
				active ? "text-info" : "text-ink-faint hover:text-ink"
			}`}
		>
			{children}
		</button>
	);
}
