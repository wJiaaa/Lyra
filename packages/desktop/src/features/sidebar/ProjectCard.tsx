/**
 * What a project's name row cannot say, on hover: how many conversations it holds and which folders
 * it is made of.
 *
 * The folders are how two projects with one name are told apart. The row only carries the name — a
 * faint parent folder after every shared name was noise the rest of the time — so the place to look
 * is here, where the whole path has room. Look and placement are `SessionCard`'s; so is the hover
 * timing, through `useSessionCard`.
 */

import { Folder, MessageCircle } from "../../ui/icons/index.ts";
import { projectFolders } from "@plume/core/project-folders";
import { translate } from "../../i18n/translate.ts";
import { tildeHome } from "../../lib/paths.ts";
import { portal } from "../../ui/overlay/portal.ts";
import { useApp } from "../../store/index.ts";
import { CARD_Z, useCardPlacement } from "./SessionCard.tsx";

export function ProjectCard({ id, name, path, count, anchor, leaving }: {
	id: string;
	name: string;
	path: string;
	/** Conversations listed under it. */
	count: number;
	/** The row's rectangle, in viewport coordinates. */
	anchor: DOMRect;
	leaving?: boolean;
}) {
	const entry = useApp((s) => s.settings?.projects.find((project) => project.id === id));
	const folders = entry ? projectFolders(entry) : [path];
	const { card, at } = useCardPlacement(anchor);

	return portal(<div
		ref={card}
		role="tooltip"
		data-ly-project-card=""
		style={{ zIndex: CARD_Z, left: at?.left ?? -9999, top: at?.top ?? -9999, opacity: at ? undefined : 0 }}
		className={`ly-glass-solid pointer-events-none fixed w-max max-w-[340px] min-w-[220px] overflow-hidden rounded-xl border border-line-soft px-3 py-2.5 ${
			leaving ? "ly-card-out" : "ly-card-in"
		}`}
	>
		<p className="truncate text-label text-ink">{name}</p>
		<p className="mt-1 flex items-center gap-1.5 text-detail text-ink-muted">
			<MessageCircle size={11.5} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
			{translate("projectCard.chats", { n: count })}
		</p>
		<div className="mt-2 flex flex-col gap-1">
			{folders.map((folder) => (
				<p key={folder} data-ly-project-card-folder="" className="flex items-start gap-1.5 text-detail text-ink-muted">
					<Folder size={11.5} strokeWidth={1.9} className="mt-[3px] shrink-0 text-ink-faint" />
					{/* Wrapped, not cut: the end of the path is the part that tells two of them apart. */}
					<span className="min-w-0 [overflow-wrap:anywhere]">{tildeHome(folder)}</span>
				</p>
			))}
		</div>
	</div>);
}
