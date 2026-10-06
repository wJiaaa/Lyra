import { Input } from "../../ui/inputs/NativeField.tsx";
import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronRight,
	Columns2,
	Copy,
	CornerUpRight,
	ExternalLink,
	Folder,
	FolderInput,
	History,
	Mail,
	MailOpen,
	Pencil,
	Pin,
	PinOff,
	Trash2,
	X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { SessionMeta } from "@plume/core";
import { MenuBody, MenuItem, MenuSeparator, Popover, type Anchor } from "../../ui/overlay/Popover.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { bridge } from "../../services/index.ts";
import { useRevealLabel } from "../../store/open-targets.ts";
import { canOfferSplit, canSplit, contains, openInNewWindow, SplitMoveItems, splitWith, useSplit } from "../split/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";

export function SessionMenu({
	anchor,
	session,
	onClose,
	onRequestDelete,
	onShowTrajectory,
}: {
	anchor: Anchor;
	session: SessionMeta;
	onClose: () => void;
	/**
	 * Ask to delete this session — the confirmation belongs to whoever opened this menu.
	 *
	 * It cannot live here. A confirmation is rendered by the component that asks for it, and this
	 * component is unmounted the instant it is asked: the delete item closes the menu, `SessionRow`
	 * drops it from the tree, and the dialog goes with it. So the click reported nothing, showed
	 * nothing, and deleted nothing — see `SessionRow`, which outlives the menu and holds it instead.
	 */
	onRequestDelete: () => void;
	/**
	 * 打开这条会话的调用轨迹。由打开菜单的一方给：轨迹面板在 `dock` 里，而 `dock` 经浏览器、输入框
	 * 一路引回这里，从这里直接引它就成环了。不给就不显示这一项。
	 */
	onShowTrajectory?: () => void;
}) {
	const { t } = useI18n();
	const splitTree = useSplit((s) => s.tree);
	const settings = useApp((s) => s.settings);
	const setSessionPinned = useApp((s) => s.setSessionPinned);
	const setSessionArchived = useApp((s) => s.setSessionArchived);
	const setSessionUnread = useApp((s) => s.setSessionUnread);
	const renameSession = useApp((s) => s.renameSession);
	const moveSessionProject = useApp((s) => s.moveSessionProject);
	const notify = useApp((s) => s.notify);
	const reveal = useRevealLabel();

	const [mode, setMode] = useState<"menu" | "rename" | "projects">("menu");
	const [openIn, setOpenIn] = useState(false);
	const openInRow = useRef<HTMLDivElement>(null);
	const openInLeave = useRef<number>(0);
	const showOpenIn = () => {
		window.clearTimeout(openInLeave.current);
		setOpenIn(true);
	};
	const hideOpenIn = () => {
		openInLeave.current = window.setTimeout(() => setOpenIn(false), 160);
	};
	const [draft, setDraft] = useState(session.title);

	const isPinned = settings?.pinnedSessionIds?.includes(session.id) ?? false;
	const isUnread = settings?.unreadSessionIds?.includes(session.id) ?? false;
	const projects = settings?.projects ?? [];
	const copy = async (text: string | Promise<string>, done: string) => {
		onClose();
		await navigator.clipboard.writeText(await text);
		notify(done);
	};

	if (mode === "rename") {
		return (
			<Popover anchor={anchor} onClose={onClose} placement="right" width="compact" role="dialog" label={t("sessionMenu.rename")}>
				<form
					className="p-2.5"
					onSubmit={(e) => {
						e.preventDefault();
						void renameSession(session, draft);
						onClose();
					}}
				>
					<label className="block pb-1.5 text-detail text-ink-faint">{t("sessionMenu.titleLabel")}</label>
					<Input
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setMode("menu");
								setDraft(session.title);
							}
						}}
						className="h-8 w-full rounded-lg border border-line bg-input px-2.5 text-label text-ink placeholder:text-ink-faint focus:border-ink-faint"
					/>
					<div className="flex justify-end gap-1.5 pt-2.5">
						<Button variant="subtle" size="sm" label={t("common.cancel")} onClick={() => setMode("menu")} icon={<X size={13} strokeWidth={2} aria-hidden />} />
						<Button
							type="submit"
							variant="primary"
							size="sm"
							label={t("common.save")}
							disabled={!draft.trim()}
							icon={<Check size={13} strokeWidth={2.2} aria-hidden />}
						/>
					</div>
				</form>
			</Popover>
		);
	}

	if (mode === "projects") {
		return (
			<Popover anchor={anchor} onClose={onClose} placement="right" width="compact" label={t("sessionMenu.moveToProject")}>
				<MenuBody>
					<MenuItem
						icon={<FolderInput size={13} strokeWidth={1.8} />}
						onClick={() => {
							setMode("menu");
						}}
					>
						{t("common.back")}
					</MenuItem>
					<MenuSeparator />
					{projects.map((p) => {
						const isCurrent = session.cwd === p.path;
						return (
							<MenuItem
								key={p.path}
								icon={<Folder size={13} strokeWidth={1.8} />}
								hint={isCurrent ? t("sessionMenu.currentProject") : undefined}
								disabled={isCurrent}
								onClick={() => {
									void moveSessionProject(session, p.path);
									onClose();
								}}
							>
								{p.name}
							</MenuItem>
						);
					})}
					{session.cwd && (
						<>
							<MenuSeparator />
							<MenuItem
								icon={<FolderInput size={13} strokeWidth={1.8} />}
								onClick={() => {
									void moveSessionProject(session, "");
									onClose();
								}}
							>
								{t("sessionMenu.removeFrom", { name: session.projectName || t("sessionMenu.project") })}
							</MenuItem>
						</>
					)}
				</MenuBody>
			</Popover>
		);
	}

	return (
		<>
			<Popover anchor={anchor} onClose={onClose} placement="right" width="compact" label={t("sessionMenu.options")}>
				<MenuBody>
					{!session.archived && (
						<MenuItem
							icon={isPinned ? <PinOff size={13} strokeWidth={1.8} /> : <Pin size={13} strokeWidth={1.8} />}
							onClick={() => {
								void setSessionPinned(session.id, !isPinned);
								notify(isPinned ? t("sessionMenu.unpinned") : t("sessionMenu.pinned"));
								onClose();
							}}
						>
							{isPinned ? t("sessionMenu.unpin") : t("sessionMenu.pin")}
						</MenuItem>
					)}

					<MenuItem
						icon={<Pencil size={13} strokeWidth={1.8} />}
						onClick={() => {
							setDraft(session.title);
							setMode("rename");
						}}
					>
						{t("common.rename")}
					</MenuItem>

					<MenuItem
						icon={session.archived ? <ArchiveRestore size={13} strokeWidth={1.8} /> : <Archive size={13} strokeWidth={1.8} />}
						onClick={() => {
							void setSessionArchived(session, !session.archived);
							onClose();
						}}
					>
						{session.archived ? t("common.unarchive") : t("common.archive")}
					</MenuItem>

					{!session.archived && (
						<MenuItem
							icon={isUnread ? <MailOpen size={13} strokeWidth={1.8} /> : <Mail size={13} strokeWidth={1.8} />}
							onClick={() => {
								void setSessionUnread(session.id, !isUnread);
								notify(isUnread ? t("sessionMenu.markedRead") : t("sessionMenu.markedUnread"));
								onClose();
							}}
						>
							{isUnread ? t("sessionMenu.markRead") : t("sessionMenu.markUnread")}
						</MenuItem>
					)}

					{session.archived && (
						<MenuItem
							icon={<Trash2 size={13} strokeWidth={1.8} className="text-danger" />}
							onClick={() => {
								onClose();
								onRequestDelete();
							}}
						>
							<span className="text-danger">{t("common.delete")}</span>
						</MenuItem>
					)}

					<MenuSeparator />

					<MenuItem icon={<Folder size={13} strokeWidth={1.8} />} onClick={() => setMode("projects")}>
						{t("sessionMenu.project")}
					</MenuItem>

					<div
						ref={openInRow}
						data-ly-open-in=""
						onMouseEnter={showOpenIn}
						onMouseLeave={hideOpenIn}
					>
						<MenuItem
							icon={<ExternalLink size={13} strokeWidth={1.8} />}
							trailing={<ChevronRight size={13} strokeWidth={1.8} className="text-ink-faint" />}
							onClick={showOpenIn}
						>
							{t("sessionMenu.openIn")}
						</MenuItem>
						{openIn && openInRow.current && (
							<Popover
								anchor={openInRow.current}
								onClose={() => setOpenIn(false)}
								placement="right"
								align="start"
								width="compact"
								label={t("sessionMenu.openIn")}
								onMouseEnter={showOpenIn}
								onMouseLeave={hideOpenIn}
							>
								<MenuBody>
									<MenuItem
										icon={<Columns2 size={13} strokeWidth={1.8} />}
										disabled={!contains(splitTree, session.id) && !(canSplit(splitTree) && canOfferSplit())}
										onClick={() => {
											const pane = document.querySelector<HTMLElement>("[data-ly-split-focused]");
											const box = (pane ?? document.querySelector("[data-ly-split-root]"))?.getBoundingClientRect();
											splitWith(session, pane?.dataset.lySplitPane === "@draft" ? null : pane?.dataset.lySplitPane ?? null, box?.width ?? 800, box?.height ?? 600);
											onClose();
										}}
									>
										{t("sessionMenu.splitView")}
									</MenuItem>
									<MenuItem
										icon={<ExternalLink size={13} strokeWidth={1.8} />}
										onClick={() => {
											void openInNewWindow(session.id);
											onClose();
										}}
									>
										{t("sessionMenu.newWindow")}
									</MenuItem>
								</MenuBody>
							</Popover>
						)}
					</div>
					<SplitMoveItems sessionId={session.id} onClose={onClose} />

					<MenuSeparator />

					{session.cwd && (
						<MenuItem
							icon={<CornerUpRight size={13} strokeWidth={1.8} />}
							onClick={() => {
								void bridge.workspace.reveal(session.cwd);
								onClose();
							}}
						>
							{reveal}
						</MenuItem>
					)}
					{session.cwd && (
						<MenuItem icon={<Copy size={13} strokeWidth={1.8} />} onClick={() => void copy(session.cwd, t("sessionMenu.cwdCopied"))}>
							{t("sessionMenu.copyCwd")}
						</MenuItem>
					)}
					<MenuItem
						icon={<Copy size={13} strokeWidth={1.8} />}
						onClick={() =>
							void copy(bridge.sessions.exportTrajectory(session.id, "jsonl"), t("sessionMenu.recordsExported")).catch((error) => notify(String(error), "error"))
						}
					>
						{t("sessionMenu.exportRecords")}
					</MenuItem>
					<MenuItem icon={<Copy size={13} strokeWidth={1.8} />} onClick={() => void copy(session.id, t("sessionMenu.sessionIdCopied"))}>
						{t("sessionMenu.copySessionId")}
					</MenuItem>

					{onShowTrajectory && (
						<>
							<MenuSeparator />
							<MenuItem
								icon={<History size={13} strokeWidth={1.8} />}
								onClick={() => {
									onClose();
									onShowTrajectory();
								}}
							>
								{t("sessionMenu.viewTrajectory")}
							</MenuItem>
						</>
					)}
				</MenuBody>
			</Popover>
		</>
	);
}
