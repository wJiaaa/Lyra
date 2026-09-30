import { Database, RefreshCw } from "lucide-react";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useListedProjects } from "../../store/listed-projects.ts";
import { Card, EmptyHint, InlineSelect, Row, SectionTitle } from "./controls.tsx";
import { DialogAction } from "../../ui/overlay/Dialog.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";

interface Stats {
	exists: boolean;
	builtAt?: number;
	files?: number;
	symbols?: number;
	bytes?: number;
}

export function IndexSettings() {
	const { t, resolvedLocale } = useI18n();
	// The page picks its own project, independent of the open conversation: following the global
	// workspace meant the only way to look at another project's index was to go and open one of
	// its conversations.
	const projects = useListedProjects();
	const [picked, setPicked] = useState<string | null>(null);
	const path = projects.find((p) => p.path === picked)?.path ?? projects[0]?.path ?? null;
	const pathRef = useRef(path);
	pathRef.current = path;
	const [stats, setStats] = useState<Stats | null>(null);
	// The path being built, so a rebuild left running does not spin or land on another project.
	const [building, setBuilding] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<{ name: string; kind: string; file: string; line: number }[]>([]);

	const refresh = useCallback(async () => {
		setStats(null);
		if (!path) return;
		const result = await bridge.index.stats(path);
		if (pathRef.current === path) setStats(result);
	}, [path]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Search as you type — the index is in memory on the main side, so this is cheap.
	useEffect(() => {
		if (!path || query.trim().length < 2) {
			setHits([]);
			return;
		}
		let cancelled = false;
		void bridge.index.search(path, query.trim()).then((result) => {
			if (!cancelled) setHits(result);
		});
		return () => {
			cancelled = true;
		};
	}, [path, query]);

	const isBuilding = building !== null && building === path;

	return (
		<div className="pt-2">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("index.title")}</h1>
			<p className="mt-2 max-w-[580px] pb-7 text-label leading-relaxed text-ink-muted">
				{t("index.recordsWhat")}<strong className="font-medium text-ink">{t("index.definitions")}</strong>{t("index.definitionsDetail")}
			</p>

			{!path ? (
				<Card>
					<EmptyHint>{t("index.noProjects")}</EmptyHint>
				</Card>
			) : (
				<>
					<SectionTitle>{t("common.status")}</SectionTitle>
					<Card className="mb-7">
						<Row
							title={t("common.project")}
							detail={path}
							control={
								<div className="flex items-center gap-2">
									<InlineSelect
										value={path}
										onChange={setPicked}
										options={projects.map((p) => ({ value: p.path, label: p.name, detail: p.path }))}
										ariaLabel={t("common.project")}
									/>
									<DialogAction
										disabled={building !== null}
										onClick={() => {
											const target = path;
											void (async () => {
												setBuilding(target);
												try {
													const result = await bridge.index.rebuild(target);
													if (pathRef.current === target) setStats(result);
												} finally {
													setBuilding(null);
												}
											})();
										}}
										label={isBuilding ? t("index.building") : stats?.exists ? t("index.rebuild") : t("index.build")}
										data-ly-index-rebuild=""
									>
										{isBuilding ? <ActionSpinner size={13} /> : <RefreshCw size={13} strokeWidth={2} aria-hidden />}
										{isBuilding ? t("index.building") : stats?.exists ? t("index.rebuild") : t("index.build")}
									</DialogAction>
								</div>
							}
						/>
						<Row
							title={t("index.symbols")}
							control={
								<span className="font-mono text-label text-ink">
									{stats?.symbols?.toLocaleString()}
								</span>
							}
						/>
						<Row
							title={t("index.files")}
							control={<span className="font-mono text-label text-ink">{stats?.files?.toLocaleString()}</span>}
						/>
						<Row
							title={t("index.size")}
							control={
								<span className="font-mono text-label text-ink">
									{stats?.bytes ? `${(stats.bytes / 1024).toFixed(0)} KB` : null}
								</span>
							}
						/>
						<Row
							title={t("index.lastBuilt")}
							control={
								<span className="text-label text-ink-muted">
									{stats?.builtAt ? new Date(stats.builtAt).toLocaleString(resolvedLocale) : t("common.never")}
								</span>
							}
						/>
					</Card>

					<SectionTitle>{t("index.trySearch")}</SectionTitle>
					<Card>
						<div className="border-b border-line-soft p-3">
							<SearchField
								size="comfortable"
								value={query}
								onChange={setQuery}
								placeholder={t("index.searchPlaceholder")}
								className="w-full"
							/>
						</div>

						{hits.length === 0 ? (
							<EmptyHint>
								{query.trim().length < 2
									? t("index.tooShort")
									: stats?.exists
										? t("index.noSymbols")
										: t("index.buildFirst")}
							</EmptyHint>
						) : (
							<Scroller className="max-h-[340px]" overscroll="auto">
								{hits.map((hit) => (
									<button
										key={`${hit.file}:${hit.line}`}
										type="button"
										onClick={() => void bridge.system.openPath(`${path}/${hit.file}`)}
										className="flex w-full items-center gap-2.5 border-b border-line-soft px-4 py-2 text-left transition-colors last:border-b-0 hover:bg-card-hover/50"
									>
										<Database size={12} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
										<span className="shrink-0 font-mono text-label text-ink">{hit.name}</span>
										<span className="shrink-0 rounded bg-card px-1.5 py-0.5 text-caption text-ink-faint">
											{hit.kind}
										</span>
										<span className="min-w-0 flex-1 truncate text-right font-mono text-detail text-ink-muted">
											{hit.file}:{hit.line}
										</span>
									</button>
								))}
							</Scroller>
						)}
					</Card>
				</>
			)}
		</div>
	);
}
