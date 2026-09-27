import type { ModelConfig, ProviderConfig, SmartField } from "@lyra/core";
import { catalogModelFor, catalogPricing, type CatalogMatch } from "@lyra/core/model-catalog";
import { resolveModelRules, SMART_FIELDS, withSmartConfig } from "@lyra/core/model-rules";
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

export function ModelEditor({
	provider,
	model: savedModel,
	onSave,
	onCancel,
}: {
	provider: Pick<ProviderConfig, "id" | "baseUrl" | "api">;
	model: ModelConfig | null;
	onSave: (model: ModelConfig) => void;
	onCancel: () => void;
}) {
	const { t } = useI18n();
	const model = savedModel ? withSmartConfig(provider, savedModel) : null;
	const [catalogRef, setCatalogRef] = useState(model?.catalogRef);
	const initialCatalog = model ? catalogModelFor(provider, model.modelId, model.catalogRef) : null;
	const initialPricing = model?.pricing ?? (initialCatalog ? catalogPricing(initialCatalog.provider.id, initialCatalog.model) : undefined);
	const [modelId, setModelId] = useState(model?.modelId ?? "");
	const [name, setName] = useState(model?.name ?? "");
	/*
	 * 智能配置：新模型默认开着。开着时没被改过的字段显示推荐值，改了哪一项，哪一项就记进
	 * `overrides`、不再跟随推荐；关掉则把当前看到的值整份冻结成手动。旧数据里没有标记的模型是人手
	 * 定的值，打开时仍是手动。
	 */
	const [smart, setSmart] = useState(model ? model.metadataSource === "smart" : true);
	const [overrides, setOverrides] = useState<ReadonlySet<SmartField>>(new Set(model?.overrides ?? []));
	const [own, setOwn] = useState(() => ({
		contextWindow: String(model?.contextWindow ?? ""),
		maxOutputTokens: String(model?.maxOutputTokens ?? ""),
		supportsThinking: model?.supportsThinking ?? true,
		supportsImages: model?.supportsImages ?? true,
		supportsTools: model?.supportsTools ?? true,
	}));
	const trimmedId = modelId.trim();
	const recommended = resolveModelRules(provider, trimmedId);
	const follows = (field: SmartField) => smart && !overrides.has(field);
	const contextWindow = follows("contextWindow") ? String(recommended.config.contextWindow) : own.contextWindow;
	const maxOutput = follows("maxOutputTokens")
		? String(Math.min(recommended.config.maxOutputTokens, Number(contextWindow) || recommended.config.maxOutputTokens))
		: own.maxOutputTokens;
	const supportsThinking = follows("supportsThinking") ? recommended.config.supportsThinking : own.supportsThinking;
	const supportsImages = follows("supportsImages") ? recommended.config.supportsImages : own.supportsImages;
	const supportsTools = follows("supportsTools") ? recommended.config.supportsTools : own.supportsTools;
	const [priceIn, setPriceIn] = useState(String(initialPricing?.input ?? ""));
	const [priceOut, setPriceOut] = useState(String(initialPricing?.output ?? ""));
	const [priceCacheRead, setPriceCacheRead] = useState(String(initialPricing?.cacheRead ?? ""));
	const [priceCacheWrite, setPriceCacheWrite] = useState(String(initialPricing?.cacheWrite ?? ""));
	const [pricingSource, setPricingSource] = useState<"manual" | "catalog" | null>(
		initialPricing ? initialPricing.source ?? (model?.pricing ? "manual" : "catalog") : null,
	);

	const window_ = Number(contextWindow);
	const output = Number(maxOutput);
	const windowOk = Number.isInteger(window_) && window_ > 0 && window_ <= 100_000_000;
	const outputOk = Number.isInteger(output) && output > 0 && output <= window_;
	const catalog = catalogModelFor(provider, trimmedId, catalogRef);
	const parsePrice = (value: string) => {
		if (!value.trim()) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
	};
	const prices = [priceIn, priceOut, priceCacheRead, priceCacheWrite].map(parsePrice);
	const pricingComplete = prices[0] !== null && prices[1] !== null;
	const pricingEmpty = prices.every((price) => price === null);
	const pricingOk = prices.every((price) => price === null || Number.isFinite(price)) && (pricingComplete || pricingEmpty);
	const valid = trimmedId.length > 0 && windowOk && outputOk && pricingOk;

	function changePrice(setter: (value: string) => void, value: string) {
		setter(value);
		setPricingSource("manual");
	}

	/** The catalogue is only consulted for price; limits and capabilities are the smart config's. */
	function applyCatalog(found: CatalogMatch) {
		const entry = found.model;
		setCatalogRef(found.match === "binding" ? { providerId: found.provider.id, modelId: entry.id } : undefined);
		setPriceIn(String(entry.inputPrice ?? ""));
		setPriceOut(String(entry.outputPrice ?? ""));
		setPriceCacheRead(entry.cacheReadPrice === undefined ? "" : String(entry.cacheReadPrice));
		setPriceCacheWrite(entry.cacheWritePrice === undefined ? "" : String(entry.cacheWritePrice));
		setPricingSource("catalog");
	}

	function changeModelId(value: string) {
		// 显示名称还跟着模型 ID 走（没人改过）时一起变。
		if (!name.trim() || name === modelId) setName(value);
		setModelId(value);
		setCatalogRef(undefined);
		if (pricingSource === "manual") return;
		const found = catalogModelFor(provider, value);
		if (found) applyCatalog(found);
		else {
			setPricingSource(null);
			setPriceIn(""); setPriceOut(""); setPriceCacheRead(""); setPriceCacheWrite("");
		}
	}

	/** 手动改一项：智能模式下这一项从此不再跟随推荐。 */
	function changeField<K extends SmartField>(field: K, value: (typeof own)[K]) {
		setOwn((current) => ({ ...current, [field]: value }));
		if (smart) setOverrides((current) => new Set(current).add(field));
	}

	function changeSmart(next: boolean) {
		if (!next) {
			// 关掉时把眼前的值整份接过来，看到什么就存什么。
			setOwn({ contextWindow, maxOutputTokens: maxOutput, supportsThinking, supportsImages, supportsTools });
		}
		setOverrides(new Set());
		setSmart(next);
	}

	function submit() {
		if (!valid) return;
		const [parsedIn, parsedOut, parsedCacheRead, parsedCacheWrite] = prices;
		const cataloguePricing = pricingSource === "catalog" && catalog ? catalogPricing(catalog.provider.id, catalog.model) : null;
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
			catalogRef,
			metadataSource: smart ? "smart" : "manual",
			overrides: smart && overrides.size > 0 ? SMART_FIELDS.filter((field) => overrides.has(field)) : undefined,
			pricing:
				parsedIn !== null && parsedOut !== null
					? {
						...cataloguePricing,
						input: parsedIn,
						output: parsedOut,
						cacheRead: parsedCacheRead ?? undefined,
						cacheWrite: parsedCacheWrite ?? undefined,
						source: cataloguePricing ? "catalog" : "manual",
					}
					: undefined,
		});
	}

	/** 智能模式下手动定过的字段，在标签上标出来。 */
	const fieldLabel = (field: SmartField, label: string) => (smart && overrides.has(field) ? `${label} · ${t("modelEditor.pinned")}` : label);

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

						<div className="space-y-1.5 rounded-[10px] border border-line px-3.5 py-3">
							<label className="flex items-center justify-between">
								<span className="text-label font-medium text-ink">{t("modelEditor.smart")}</span>
								<Toggle checked={smart} onChange={changeSmart} />
							</label>
							<p className="text-detail text-ink-faint">{t("modelEditor.smartDetail")}</p>
							{smart && overrides.size > 0 && (
								<div className="flex items-center justify-between gap-3">
									<span className="text-detail text-ink-muted">{t("modelEditor.pinnedCount", { n: overrides.size })}</span>
									<button type="button" onClick={() => changeSmart(true)} className="shrink-0 rounded-lg px-2 py-1 text-label font-medium text-accent hover:bg-accent/10">
										{t("modelEditor.restoreSmart")}
									</button>
								</div>
							)}
							{smart && !recommended.specific && <p className="text-detail text-ink-muted">{t("modelEditor.unverified")}</p>}
						</div>

						<div className="grid grid-cols-2 gap-3">
							<Field label={fieldLabel("contextWindow", t("modelEditor.context"))}>
								<TextInput value={contextWindow} onChange={(value) => { if (isLegalDraft(value, CONTEXT)) changeField("contextWindow", value); }} mono inputMode="numeric" />
							</Field>
							<Field label={fieldLabel("maxOutputTokens", t("modelEditor.maxOutput"))}>
								<TextInput value={maxOutput} onChange={(value) => { if (isLegalDraft(value, OUTPUT)) changeField("maxOutputTokens", value); }} mono inputMode="numeric" />
							</Field>
						</div>

						<div className="space-y-3 rounded-[10px] border border-line px-3.5 py-3">
							<Capability label={fieldLabel("supportsThinking", t("modelEditor.thinking"))} checked={supportsThinking} onChange={(value) => changeField("supportsThinking", value)} />
							<Capability label={fieldLabel("supportsImages", t("modelEditor.images"))} checked={supportsImages} onChange={(value) => changeField("supportsImages", value)} />
							<Capability label={fieldLabel("supportsTools", t("modelEditor.toolCalls"))} checked={supportsTools} onChange={(value) => changeField("supportsTools", value)} />
						</div>

						<ModelCatalog match={catalog} onApply={applyCatalog} />

						<div className="grid grid-cols-2 gap-3">
							<Field label={t("modelEditor.inputPrice")}>
								<TextInput value={priceIn} onChange={(value) => { if (isLegalDraft(value, PRICE)) changePrice(setPriceIn, value); }} placeholder={t("common.notSet")} mono inputMode="decimal" />
							</Field>
							<Field label={t("modelEditor.outputPrice")}>
								<TextInput value={priceOut} onChange={(value) => { if (isLegalDraft(value, PRICE)) changePrice(setPriceOut, value); }} placeholder={t("common.notSet")} mono inputMode="decimal" />
							</Field>
							<Field label={t("modelEditor.cacheReadPrice")}>
								<TextInput value={priceCacheRead} onChange={(value) => { if (isLegalDraft(value, PRICE)) changePrice(setPriceCacheRead, value); }} placeholder={t("common.notSet")} mono inputMode="decimal" />
							</Field>
							<Field label={t("modelEditor.cacheWritePrice")}>
								<TextInput value={priceCacheWrite} onChange={(value) => { if (isLegalDraft(value, PRICE)) changePrice(setPriceCacheWrite, value); }} placeholder={t("common.notSet")} mono inputMode="decimal" />
							</Field>
						</div>
						<p className="-mt-2 text-detail text-ink-faint">
							{pricingEmpty
								? t("modelEditor.noPriceDetail")
								: pricingSource === "catalog"
									? `${t("modelEditor.catalogPrice")}${catalog?.model.tiers?.length ? t("modelEditor.catalogTiers", { n: catalog.model.tiers.length }) : ""}`
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
