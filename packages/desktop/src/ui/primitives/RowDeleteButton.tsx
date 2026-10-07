import { Trash2 } from "../icons/index.ts";
import { IconButton } from "./IconButton.tsx";

/** Keep the action's slot stable, including when only hover or keyboard focus reveals it. */
export function RowDeleteButton({ label, onClick, pending = false }: {
	label: string;
	onClick: () => void;
	pending?: boolean;
}) {
	return <span className="ly-row-action relative flex shrink-0" data-pending={pending || undefined}>
		<IconButton label={label} tone="danger" icon={<Trash2 size={14} strokeWidth={1.8} />}
			disabled={pending} onClick={(event) => { event.stopPropagation(); onClick(); }} />
	</span>;
}
