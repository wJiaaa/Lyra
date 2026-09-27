import type { ModelConfig, ModelPricing, ProviderConfig } from "@lyra/core";
import { catalogFill, catalogModelFor, DEFAULT_MODEL_LIMITS, type CatalogModel } from "@lyra/core/model-catalog";
import { ModelCatalog } from "./ModelCatalog.tsx";
import { Box } from "lucide-react";
import { useState } from "react";
import { DialogAction, DialogFrame } from "../../ui/overlay/Dialog.tsx";
import { Overlay } from "../../ui/overlay/Overlay.tsx";
import { isLegalDraft } from "../../lib/number-draft.ts";
import { Field, TextInput, Toggle } from "./controls.tsx";
import { useI18n } from "../../i18n/index.ts";

const CONTEXT = { min: 1, max: 100_000_000, step: 1 };
const OUTPUT = { min: 1, max: 100_000_000, step: 1 };
const PRICE = { min: 0, max: 1_000_000, step: 0.000001 };

type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";
type Prices = Record<PriceKey, string>;

function pricesOf(pricing: ModelPricing | undefined): Prices {
	const text = (value: number | undefined) => (value === undefined ? "" : String(value));
	return { input: text(pricing?.input), output: text(pricing?.output), cacheRead: text(pricing?.cacheRead), cacheWrite: text(pricing?.cacheWrite) };
}

export function ModelEditor({
	provider,
	model,
	onSave,
	onCancel,
}: {
	provider: Pick<ProviderConfig, "id" | "baseUrl">;
	model: ModelConfig | null;
	onSave: (model: ModelConfig) => void;
	onCancel: () => void;
}) {
	const { t } = useI18n();
	const [modelId, setModelId] = useState(model?.modelId ?? "");
	const [name, setName] = useState(model?.name ?? "");
	const initial = model ?? DEFAULT_MODEL_LIMITS;
	const [contextWindow, setContextWindow] = useState(String(initial.contextWindow));
	const [maxOutput, setMaxOutput] = useState(String(initial.maxOutputTokens));
	const [supportsThinking, setSupportsThinking] = useState(initial.supportsThinking);
	const [supportsImages, setSupportsImages] = useState(initial.supportsImages);
	const [supportsTools, setSupportsTools] = useState(initial.supportsTools);
	const [prices, setPrices] = useState(() => pricesOf(model?.pricing));
	/*
	 * 表单里这组价格对应的完整价格记录——从目录填入的（带长上下文阶梯和来源），或者已保存的。改了任何
	 * 一项价格它就作废，保存时按表单里的数字存成手动价格。
	 */
	const [storedPricing, setStoredPricing] = useState(model?.pricing);

	const trimmedId = modelId.trim();
	const suggestion = trimmedId ? catalogModelFor(provider, trimmedId) : null;
	const window_ = Number(contextWindow);
	const output = Number(maxOutput);
	const windowOk = Number.isInteger(window_) && window_ > 0 && window_ <= 100_000_000;
	const outputOk = Number.isInteger(output) && output > 0 && output <= window_;
	const parsePrice = (value: string) => {
		if (!value.trim()) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
	};
	const parsed = [prices.input, prices.output, prices.cacheRead, prices.cacheWrite].map(parsePrice);
	const pricingComplete = parsed[0] !== null && parsed[1] !== null;
	const pricingEmpty = parsed.every((price) => price === null);
	const pricingOk = parsed.every((price) => price === null || Number.isFinite(price)) && (pricingComplete || pricingEmpty);
	const valid = trimmedId.length > 0 && windowOk && outputOk && pricingOk;

	/** 把一个目录条目的值填进表单。只是填一次，之后怎么改都行。 */
	function fill(entry: { provider: { id: string }; model: CatalogModel }) {
		const values = catalogFill(entry.provider.id, entry.model);
		setContextWindow(String(values.contextWindow));
		setMaxOutput(String(values.maxOutputTokens));
		setSupportsThinking(values.supportsThinking);
		setSupportsImages(values.supportsImages);
		setSupportsTools(values.supportsTools);
		setPrices(pricesOf(values.pricing));
		setStoredPricing(values.pricing);
	}

	function changePrice(key: PriceKey, value: string) {
		setPrices((current) => ({ ...current, [key]: value }));
		setStoredPricing(undefined);
	}

	function changeModelId(value: string) {
		// 显示名称还跟着模型 ID 走（没人改过）时一起变。
		if (!name.trim() || name === modelId) setName(value);
		setModelId(value);
	}

	function submit() {
		if (!valid) return;
		const [parsedIn, parsedOut, parsedCacheRead, parsedCacheWrite] = parsed;
		onSave({
			...model,
			id: `${provider.id}/${trimmedId}`,
			providerId: provider.id,
			modelId: trimmedId,
			name: name.trim() || trimmedId,
			contextWindow: window_,
			maxOutputTokens: output,
			supportsThinking,
			supportsImages,
			supportsTools,
			pricing: storedPricing
				?? (parsedIn !== null && parsedOut !== null
					? { input: parsedIn, output: parsedOut, cacheRead: parsedCacheRead ?? undefined, cacheWrite: parsedCacheWrite ?? undefined, source: "manual" }
					: undefined),
		});
	}

	const priceField = (key: PriceKey, label: string) => (
		<Field label={label}>
			<TextInput value={prices[key]} onChange={(value) => { if (isLegalDraft(value, PRICE)) changePrice(key, value); }} placeholder={t("common.notSet")} mono inputMode="decimal" />
		</Field>
	);

	return (
		<Overlay onClose={onCancel} width={560}>
			{(dismiss) => (
				<DialogFrame
					icon={<Box size={20} className="shrink-0 text-accent" />}
					title={model ? t("modelEditor.edit") : t("modelEditor.add")}
					/* 这是一张表单，不是一个问题——默认那档高度一次只露三个字段。 */
					bodyClassName="max-h-[min(560px,58dvh)]"
					actions={(
						<>
							<div className="flex-1" />
							<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
							<DialogAction tone="primary" disabled={!valid} onClick={() => dismiss(submit)}>
								{t("common.save")}
							</DialogAction>
						</>
					)}
				>
					<div className="space-y-4">
						<Field label={t("modelEditor.id")} hint={t("modelEditor.idDetail")}>
							<TextInput value={modelId} onChange={changeModelId} placeholder="deepseek-v4-flash" mono spellCheck={false} />
						</Field>

						<Field label={t("modelEditor.displayName")} hint={t("modelEditor.displayNameDetail")}>
							<TextInput value={name} onChange={setName} placeholder="DeepSeek V4 Flash" />
						</Field>

						<ModelCatalog suggestion={suggestion} onPick={fill} />

						<div className="grid grid-cols-2 gap-3">
							<Field label={t("modelEditor.context")}>
								<TextInput value={contextWindow} onChange={(value) => { if (isLegalDraft(value, CONTEXT)) setContextWindow(value); }} mono inputMode="numeric" />
							</Field>
							<Field label={t("modelEditor.maxOutput")}>
								<TextInput value={maxOutput} onChange={(value) => { if (isLegalDraft(value, OUTPUT)) setMaxOutput(value); }} mono inputMode="numeric" />
							</Field>
						</div>

						<div className="space-y-3 rounded-[10px] border border-line px-3.5 py-3">
							<Capability label={t("modelEditor.thinking")} checked={supportsThinking} onChange={setSupportsThinking} />
							<Capability label={t("modelEditor.images")} checked={supportsImages} onChange={setSupportsImages} />
							<Capability label={t("modelEditor.toolCalls")} checked={supportsTools} onChange={setSupportsTools} />
						</div>

						<div className="grid grid-cols-2 gap-3">
							{priceField("input", t("modelEditor.inputPrice"))}
							{priceField("output", t("modelEditor.outputPrice"))}
							{priceField("cacheRead", t("modelEditor.cacheReadPrice"))}
							{priceField("cacheWrite", t("modelEditor.cacheWritePrice"))}
						</div>
						<p className="-mt-2 text-detail text-ink-faint">
							{pricingEmpty
								? t("modelEditor.noPriceDetail")
								: storedPricing?.source === "catalog"
									? `${t("modelEditor.catalogPrice")}${storedPricing.tiers?.length ? t("modelEditor.catalogTiers", { n: storedPricing.tiers.length }) : ""}`
									: t("modelEditor.manualPrice")}
						</p>

					</div>
				</DialogFrame>
			)}
		</Overlay>
	);
}

function Capability({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<label className="flex items-center justify-between">
			<span className="text-label text-ink">{label}</span>
			<Toggle checked={checked} onChange={onChange} />
		</label>
	);
}
