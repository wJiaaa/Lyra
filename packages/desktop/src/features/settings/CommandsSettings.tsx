/**
 * 斜杠命令：在输入框里敲 `/` 能用到什么。
 */

import type { BuiltinCommand } from "@plume/core/commands-builtin";
import type { SlashCommand } from "@plume/core/commands-view";
import { FolderOpen, Plus, RefreshCw, SquareTerminal, TriangleAlert } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../store/index.ts";
import { TextInput } from "./inputs.tsx";
import { ProjectScope } from "./ProjectScope.tsx";
import { Card } from "./layout.tsx";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { bridge } from "../../services/index.ts";
import { RowDeleteButton } from "../../ui/primitives/RowDeleteButton.tsx";
import { useDefinitionRemoval } from "./useDefinitionRemoval.tsx";
import { translate, useI18n } from "../../i18n/index.ts";

export function CommandsSettings() {
	const { t } = useI18n();

	return (
		<div className="pt-2">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("commands.title")}</h1>
			<p className="mt-2 text-label text-ink-muted">{t("commands.intro")}</p>
			<div className="mt-6">
				<SlashCommands />
			</div>
		</div>
	);
}

/** Where a command came from, said the same way the composer says it. */
function originOf(command: SlashCommand): string {
	if (command.origin === "claude") return command.scope === "workspace" ? translate("commands.claudeProject") : translate("commands.claudePersonal");
	if (command.origin === "agents") return command.scope === "workspace" ? translate("commands.agentsProject") : translate("commands.agentsPersonal");
	return command.scope === "workspace" ? translate("common.project") : translate("common.personal");
}

function matchesQuery(command: { name: string; description?: string; argumentHint?: string }, query: string): boolean {
	if (!query) return true;
	return [command.name, command.description, command.argumentHint].some((value) => value?.toLowerCase().includes(query));
}

/*
 * 布局照钩子页：顶上一行是范围、数量和搜索，下面「已安装」一段，每条一行，点开是编辑器。
 *
 * 新建只要一个名字——文件建好就直接进外部编辑器写正文——所以不像钩子那样换成整页表单，
 * 而是在列表上方展开一行输入，范围跟着顶上选的那个走。
 */
function SlashCommands() {
	const { t } = useI18n();
	const projects = useApp((s) => s.settings?.projects) ?? [];
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const project = projects.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? "";
	const scope = project ? "workspace" : "user";
	const [list, setList] = useState<{ commands: SlashCommand[]; builtins: BuiltinCommand[]; diagnostics: { path: string; message: string }[] } | null>(
		null,
	);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void bridge.commands.list(cwd).then(setList);
	}, [cwd]);
	const removal = useDefinitionRemoval("command", cwd, refresh);

	useEffect(refresh, [refresh]);

	/*
	 * Re-read when the window is focused again.
	 *
	 * Creating a command opens it in an external editor, so the interesting moment is coming back
	 * from that editor — without this the list still shows the description the template shipped
	 * with, and the page looks like it did not notice the file being written.
	 */
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	function startCreate() {
		setError(null);
		setCreating(true);
	}

	function cancelCreate() {
		setCreating(false);
		setName("");
		setError(null);
	}

	async function create() {
		setError(null);
		const result = await bridge.commands.create(scope, name.trim(), cwd);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setCreating(false);
		setName("");
		refresh();
		// Straight into the editor: a new command is an empty file until somebody writes the prompt.
		await bridge.commands.open(result.path);
	}

	const commands = (list?.commands ?? []).filter((command) => command.scope === scope);
	const needle = query.trim().toLowerCase();
	const visible = commands.filter((command) => matchesQuery(command, needle));
	const builtins = (list?.builtins ?? []).filter((command) => matchesQuery(command, needle));
	/*
	 * Split by whether the file loaded, which the command list already says: a misspelt field or a
	 * `---` never closed still leaves the command in the list, and counting it as failed to load
	 * contradicted its own row. Both headers count files.
	 */
	const loaded = new Set((list?.commands ?? []).map((command) => command.path));
	const diagnostics = (list?.diagnostics ?? []).filter((diagnostic) => !loaded.has(diagnostic.path));
	const warnings = (list?.diagnostics ?? []).filter((diagnostic) => loaded.has(diagnostic.path));
	const failed = new Set(diagnostics.map((diagnostic) => diagnostic.path)).size;
	const warned = new Set(warnings.map((warning) => warning.path)).size;

	return (
		<div data-ly-commands-settings="">
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<ProjectScope value={project} projects={projects} onChange={setProjectPath} />
				<div className="h-4 w-px bg-line" aria-hidden />
				<div className="flex items-center gap-1 text-label font-medium text-ink">
					{t("commands.title")}
					<span className="text-detail font-normal text-ink-faint">{visible.length}</span>
				</div>
				<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={t("commands.searchPlaceholder")} className="ml-auto max-w-[220px] flex-1 basis-[120px]" />
			</div>

			{diagnostics.length > 0 && (
				<div className="mt-5 flex items-start gap-2 rounded-[10px] border border-accent/35 bg-accent/6 px-3.5 py-2.5 text-detail text-ink-muted">
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
					<div className="min-w-0">
						<div className="text-accent">{t("commandsSettings.failedToLoad", { n: failed })}</div>
						{/* By position: a path repeats when one file has two lines, and these rows hold no state. */}
						{diagnostics.map((diagnostic, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</div>
			)}

			{warnings.length > 0 && (
				<div className="mt-5 flex items-start gap-2 rounded-[10px] border border-line px-3.5 py-2.5 text-detail text-ink-faint">
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
					<div className="min-w-0">
						<div className="text-ink-muted">{t("commandsSettings.warnings", { n: warned })}</div>
						{warnings.map((warning, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{warning.path}</span> — {warning.message}
							</div>
						))}
					</div>
				</div>
			)}

			<section className="mt-6">
				<div className="mb-4 flex items-center justify-between gap-3">
					<h2 className="flex h-7 items-center gap-1.5 text-label font-medium text-ink">
						{t("hooks.installed")}
						<span className="text-detail font-normal text-ink-faint">{commands.length}</span>
					</h2>
					<div className="flex items-center gap-1.5">
						<Button
							variant="subtle"
							size="sm"
							icon={<FolderOpen size={13} aria-hidden />}
							label={scope === "workspace" ? t("commands.openProjectDir") : t("commands.openPersonalDir")}
							onClick={() => void bridge.commands.reveal(scope, cwd)}
						/>
						<Button variant="subtle" size="sm" icon={<RefreshCw size={13} aria-hidden />} label={t("common.refresh")} onClick={refresh} />
						<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={startCreate}>
							{t("common.new")}
						</Button>
					</div>
				</div>

				{creating && (
					<Card className="mb-3">
						<div className="flex items-center gap-3 px-4 py-3">
							<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-shell text-ink-faint" aria-hidden>
								<SquareTerminal size={16} strokeWidth={1.8} />
							</div>
							<div className="min-w-0 flex-1">
								<TextInput
									value={name}
									onChange={setName}
									placeholder={t("commands.namePlaceholder")}
									autoFocus
									onKeyDown={(event) => {
										if (event.key === "Enter" && name.trim()) void create();
										if (event.key === "Escape") cancelCreate();
									}}
								/>
							</div>
							<Button variant="subtle" onClick={cancelCreate}>
								{t("common.cancel")}
							</Button>
							<Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
								{t("commands.createAndEdit")}
							</Button>
						</div>
						<p className="px-4 pb-3 text-detail text-ink-faint">
							{scope === "workspace" ? t("commands.projectScope") : t("commands.personalScope")}
							{` ${t("commands.whatIsIt")}`}
						</p>
						{error && <p className="px-4 pb-3 text-detail text-danger">{error}</p>}
					</Card>
				)}

				{commands.length === 0 ? (
					!creating && (
						<Card>
							<div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
								<div className="text-label font-medium text-ink">{t("commands.emptyTitle")}</div>
								<p className="max-w-[360px] text-detail text-ink-faint">{t("commands.whatIsIt")}</p>
								<Button variant="primary" className="mt-2" icon={<Plus size={13} aria-hidden />} onClick={startCreate}>
									{t("commands.new")}
								</Button>
							</div>
						</Card>
					)
				) : visible.length === 0 ? (
					<Card>
						<p className="px-6 py-10 text-center text-label text-ink-faint">{t("commands.searchEmpty")}</p>
					</Card>
				) : (
					<Card className="divide-y divide-line-soft">
						{visible.map((command) => (
							<CommandRow
								key={command.path}
								name={command.name}
								argumentHint={command.argumentHint}
								detail={command.description || command.path}
								onOpen={() => void bridge.commands.open(command.path)}
								openLabel={t("commands.editNamed", { name: command.name })}
								actions={
									<>
										<span className="whitespace-nowrap text-detail text-ink-faint">{originOf(command)}</span>
										<RowDeleteButton
											label={t("commands.deleteNamed", { name: command.name })}
											pending={removal.pending.has(command.path)}
											onClick={() => removal.ask(command.name, command.path)}
										/>
									</>
								}
							/>
						))}
					</Card>
				)}
			</section>

			{/*
			 * 内建的单列一段，而且不可编辑。
			 *
			 * 这一页回答的是「有哪些命令可以用」，而它此前漏掉了用得最多的三条——那三条写在
			 * `/` 菜单那个组件里，只有那一个界面知道。一个漏掉三分之一答案的列表，比没有列表
			 * 更误导人。
			 *
			 * 不混进「已安装」：它们没有文件可以打开，也不分个人和项目，而上面每一行点开都是编辑器。
			 */}
			{builtins.length > 0 && (
				<section className="mt-8">
					<h2 className="mb-4 flex h-7 items-center gap-1.5 text-label font-medium text-ink">
						{t("commands.builtin")}
						<span className="text-detail font-normal text-ink-faint">{builtins.length}</span>
					</h2>
					<Card className="divide-y divide-line-soft">
						{builtins.map((command) => (
							<CommandRow key={command.name} name={command.name} detail={command.description} />
						))}
					</Card>
				</section>
			)}
			{removal.element}
		</div>
	);
}

/** 一条命令，行的样子跟钩子页的 `HookRow` 一致。 */
function CommandRow({
	name,
	argumentHint,
	detail,
	actions,
	onOpen,
	openLabel,
}: {
	name: string;
	argumentHint?: string;
	detail?: string;
	actions?: React.ReactNode;
	onOpen?: () => void;
	openLabel?: string;
}) {
	return (
		<div
			role={onOpen ? "button" : undefined}
			tabIndex={onOpen ? 0 : undefined}
			aria-label={openLabel}
			data-row-actions=""
			onClick={onOpen}
			onKeyDown={
				onOpen
					? (event) => {
							if (event.target !== event.currentTarget) return;
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onOpen();
							}
						}
					: undefined
			}
			className={`flex cursor-default items-center gap-3 px-4 py-3 ${onOpen ? "transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover" : ""}`}
		>
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-shell text-ink-faint" aria-hidden>
				<SquareTerminal size={16} strokeWidth={1.8} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-mono text-label font-medium text-ink">
						<span className="text-ink-faint">/</span>
						{name}
					</span>
					{argumentHint && <span className="truncate font-mono text-detail text-ink-faint">{argumentHint}</span>}
				</div>
				{detail && <p className="mt-1 truncate text-detail text-ink-faint">{detail}</p>}
			</div>
			{actions && (
				<div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
					{actions}
				</div>
			)}
		</div>
	);
}
