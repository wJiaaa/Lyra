import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileAccessStatus } from "@plume/contract";
import { pairingCode } from "@plume/client-runtime";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { Check, Copy, Eye, EyeOff, TriangleAlert } from "../../ui/icons/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Text } from "../../ui/primitives/Text.tsx";
import { Card, Row, SectionTitle, Select, TextInput, Toggle } from "./controls.tsx";

// 连接数靠轮询：主进程没有为它单独推事件，而这个数只在这一页打开时才有人看。
const POLL_MS = 3000;

// 与设置页其他按钮同一档：带字的按钮 13，纯图标按钮 14。不写尺寸时 lucide 默认 24，比旁边的字大一圈。
const ICON = { size: 13, strokeWidth: 1.8 } as const;
const GLYPH = { size: 14, strokeWidth: 1.8 } as const;

const loopback = (port: number) => `http://127.0.0.1:${port}`;

/**
 * 手机能走的几条路，按该先试哪条排：中转放最前，任何网络都通；局域网其次；回环只对同一台电脑上
 * 的模拟器有用，放在最后。
 */
function routes(status: MobileAccessStatus): string[] {
	return [...(status.relay.url ? [status.relay.url] : []), ...status.addresses, loopback(status.port)];
}

const RELAY_DOT = { off: "bg-ink-faint", connecting: "bg-info", online: "bg-ok", paired: "bg-ok" } as const;
const RELAY_TEXT = { off: "mobile.relayOff", connecting: "mobile.relayConnecting", online: "mobile.relayOnline", paired: "mobile.relayPaired" } as const;

export function MobileSettings() {
	const { t } = useI18n();
	const [status, setStatus] = useState<MobileAccessStatus | null>(null);
	const [port, setPort] = useState("4517");
	const [address, setAddress] = useState("");
	const [qr, setQr] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [copied, setCopied] = useState<"link" | "token" | null>(null);
	const [reveal, setReveal] = useState(false);
	const [relayDraft, setRelayDraft] = useState<string | null>(null);
	const running = !!status?.running;
	const relayUrl = status?.relay.url ?? "";
	const addresses = status ? routes(status) : [];
	function accept(next: MobileAccessStatus) {
		setStatus(next);
		setPort(String(next.port));
		const options = routes(next);
		setAddress((current) => options.includes(current) ? current : options[0]!);
	}
	useEffect(() => { void bridge.mobile.status().then(accept).catch((cause) => setError(String(cause))); }, []);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => { void bridge.mobile.status().then(accept).catch(() => undefined); }, POLL_MS);
		return () => clearInterval(timer);
	}, [running]);
	const code = running && status?.token && address ? pairingCode({ url: address, token: status.token, relay: address === relayUrl || undefined }) : "";
	useEffect(() => {
		let current = true;
		setQr("");
		if (code) void QRCode.toDataURL(code, { width: 360, margin: 0, errorCorrectionLevel: "M" }).then((value) => { if (current) setQr(value); });
		return () => { current = false; };
	}, [code]);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(null), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	async function run(action: () => Promise<MobileAccessStatus>) {
		setBusy(true); setError("");
		try { accept(await action()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
	}
	function copy(kind: "link" | "token", text: string) {
		void bridge.clipboard.write(text).then(() => setCopied(kind)).catch((cause) => setError(String(cause)));
	}
	const clients = status?.clients ?? 0;
	const token = status?.token ?? "";

	return <div className="pt-2">
		<h1 className="pb-8 text-display leading-tight font-semibold tracking-tight text-ink">{t("mobile.title")}</h1>
		<Card className="mb-8">
			<Row title={t("mobile.access")} detail={t(running ? relayUrl ? "mobile.descriptionRelay" : "mobile.descriptionOn" : "mobile.description")} control={<Toggle checked={running} disabled={!status || busy} ariaLabel={t("mobile.access")} onChange={(on) => void run(() => on ? bridge.mobile.start(Number(port)) : bridge.mobile.stop())} />} />
			<Row title={t("mobile.port")} detail={running ? t("mobile.portLocked") : undefined} control={<TextInput aria-label={t("mobile.port")} inputMode="numeric" value={port} disabled={running || busy} onChange={(value) => setPort(value.replace(/\D/g, "").slice(0, 5))} className="w-24" />} />
			<Row title={t("mobile.relay")} detail={<span className="flex items-center gap-2">
				{relayUrl && <span aria-hidden className={`size-2 shrink-0 rounded-full ${RELAY_DOT[status!.relay.state]}`} />}
				{relayUrl ? t(RELAY_TEXT[status!.relay.state]) : t("mobile.relayHint")}
			</span>} control={<div className="flex items-center gap-2">
				<TextInput aria-label={t("mobile.relay")} mono value={relayDraft ?? relayUrl} placeholder="wss://relay.example.com" spellCheck={false} disabled={!status || busy} onChange={setRelayDraft} className="w-64" />
				<Button disabled={relayDraft === null || relayDraft.trim() === relayUrl || busy} onClick={() => void run(async () => {
					const next = await bridge.mobile.setRelay(relayDraft ?? "");
					// 刚填的中转要立刻进二维码：填它就是因为手机不在同一网络，留在局域网那条路上扫了也连不上。
					if (next.relay.url) setAddress(next.relay.url);
					return next;
				}).then(() => setRelayDraft(null))}>{t("common.save")}</Button>
			</div>} />
			{running && <Row title={<span className="flex items-center gap-2">
				<span aria-hidden className={`size-2 rounded-full ${clients ? "bg-ok" : "bg-ink-faint"}`} />
				{clients ? t("mobile.clients", { count: clients }) : t("mobile.noClients")}
			</span>} />}
		</Card>

		{running && <>
			<SectionTitle>{t("mobile.pairTitle")}</SectionTitle>
			<Card className="mb-8">
				<div className="flex flex-wrap items-center gap-8 p-6">
					{/* 二维码永远画在白底上：深色主题下直接把黑白码放在深色卡片里，有的手机相机认不出来。 */}
					<div className="shrink-0 rounded-[14px] bg-white p-3.5">
						{qr ? <img src={qr} alt={t("mobile.qr")} width={180} height={180} className="block" /> : <div className="size-[180px]" />}
					</div>
					<ol className="min-w-[220px] flex-1 space-y-4">
						{(["mobile.step1", "mobile.step2", "mobile.step3"] as const).map((step, index) => <li key={step} className="flex items-start gap-3">
							<span className="grid size-6 shrink-0 place-items-center rounded-full bg-card text-detail font-semibold text-ink-muted tabular-nums">{index + 1}</span>
							<Text as="span" size="body" className="pt-0.5">{t(step)}</Text>
						</li>)}
					</ol>
				</div>
				<div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-6 py-4">
					<Text as="div" size="label" tone="muted" className="flex-1">{t("mobile.network")}</Text>
					<div className="w-72 max-w-full">
						<Select ariaLabel={t("mobile.network")} value={address} onChange={setAddress} options={addresses.map((url) => ({ value: url, label: url, detail: url === relayUrl ? t("mobile.viaRelay") : url === loopback(status!.port) ? t("mobile.loopback") : undefined }))} />
					</div>
				</div>
				<div className="flex items-center gap-3 border-t border-line-soft px-6 py-4">
					<TriangleAlert {...GLYPH} className="shrink-0 text-ink-muted" aria-hidden />
					<Text as="p" size="label" tone="muted" className="min-w-0 flex-1 leading-relaxed">{t("mobile.secret")}</Text>
					<Button icon={copied === "link" ? <Check {...ICON} /> : <Copy {...ICON} />} onClick={() => copy("link", code)} disabled={!code}>{t(copied === "link" ? "mobile.copied" : "mobile.copy")}</Button>
				</div>
			</Card>

			<Card className="mb-8">
				<Row title={t("mobile.token")} detail={t("mobile.tokenDetail")} control={<div className="flex items-center gap-1">
					<code className="mr-1 w-40 truncate rounded-md bg-card px-2 py-1 font-mono text-detail text-ink-muted">{reveal ? token : "•".repeat(16)}</code>
					<IconButton label={t(reveal ? "mobile.hideToken" : "mobile.showToken")} onClick={() => setReveal(!reveal)} icon={reveal ? <EyeOff {...GLYPH} /> : <Eye {...GLYPH} />} />
					<IconButton label={t(copied === "token" ? "mobile.copied" : "mobile.copyToken")} onClick={() => copy("token", token)} icon={copied === "token" ? <Check {...GLYPH} /> : <Copy {...GLYPH} />} />
				</div>} />
				<Row title={t("mobile.rotate")} detail={t("mobile.rotateDetail")} control={<Button variant="danger" loading={busy} onClick={() => void run(bridge.mobile.rotateToken)}>{t("mobile.rotate")}</Button>} />
			</Card>
		</>}

		<Text as="p" size="label" tone="muted" className="leading-relaxed">{t("mobile.security")}</Text>
		{error && <p role="alert" className="mt-4 text-label text-danger">{error}</p>}
	</div>;
}
