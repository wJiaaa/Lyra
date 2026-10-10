/**
 * Every component an interface block may use, with the props each one takes.
 *
 * One table for three readers: the model is shown it (`prompt.ts`), the check measures a block
 * against it (`check.ts`), and the desktop draws from it. Three lists would drift — the failure the
 * reverse-engineered ChatGPT renderer shows is exactly this, a prop the model was taught and the
 * renderer silently drops, written again on every turn because nothing says it went nowhere.
 *
 * No `style` or `className` anywhere, and no pixel sizes: the block wears the app's own type,
 * spacing and colours, and lays itself out for whatever width the conversation has. A prop for
 * pixels is a layout that only fits the window it was written for.
 */

type PropType = "text" | "number" | "boolean" | "array" | "object" | "value" | readonly string[];

export interface PropSpec {
	type: PropType;
	required?: boolean;
}

export interface ComponentSpec {
	props: Record<string, PropSpec>;
	/** `none`: takes no children; `text`: text and expressions only; `nodes`: anything. */
	children: "none" | "text" | "nodes";
	/** The only components it may hold directly (`Tabs` holds `Tab`s). */
	holds?: string;
	/** The component it has to be directly inside. */
	within?: string;
	/** A state variable it declares: the value of this prop names it. */
	declares?: string;
	/** For the prompt: what it is, when the name does not say. */
	note?: string;
}

const TONES = ["info", "ok", "warning", "danger"] as const;
const GAP = ["sm", "md", "lg"] as const;

export const COMPONENTS: Record<string, ComponentSpec> = {
	Stack: { props: { gap: { type: GAP } }, children: "nodes", note: "vertical" },
	Row: { props: { gap: { type: GAP }, align: { type: ["start", "center", "end", "between"] } }, children: "nodes", note: "horizontal, wraps when narrow" },
	Grid: { props: { cols: { type: "number" }, gap: { type: GAP } }, children: "nodes", note: "cols is a maximum, fewer when narrow" },
	Card: { props: { title: { type: "text" }, subtitle: { type: "text" } }, children: "nodes" },
	Divider: { props: {}, children: "none" },
	Tabs: { props: { name: { type: "text" }, value: { type: "text" } }, children: "nodes", holds: "Tab", declares: "name", note: "state holds the open tab's title" },
	Tab: { props: { title: { type: "text", required: true } }, children: "nodes", within: "Tabs" },
	Each: { props: { of: { type: "array", required: true }, as: { type: "text" }, index: { type: "text" } }, children: "nodes", note: 'repeats its children; as="item" by default' },

	Heading: { props: { level: { type: "number" } }, children: "text", note: "level 1–3" },
	Text: { props: { tone: { type: ["muted", "strong", "accent", ...TONES] }, size: { type: ["sm", "md", "lg"] } }, children: "text", note: "plain text, no Markdown" },
	Badge: { props: { tone: { type: TONES } }, children: "text" },
	Callout: { props: { tone: { type: TONES }, title: { type: "text" } }, children: "nodes" },
	Stat: { props: { label: { type: "text", required: true }, value: { type: "value", required: true }, delta: { type: "value" }, hint: { type: "text" } }, children: "none", note: "delta starting with + or − is coloured" },
	Progress: { props: { value: { type: "number", required: true }, max: { type: "number" }, label: { type: "text" }, tone: { type: TONES } }, children: "none" },
	Table: { props: { columns: { type: "array" }, rows: { type: "array" }, data: { type: "array" } }, children: "none", note: "rows=[[...]] with columns=[...], or data=[{...}] (keys are the columns)" },
	Chart: {
		props: { kind: { type: ["bar", "line", "area", "pie"] }, data: { type: "array", required: true }, x: { type: "text" }, y: { type: "value" }, unit: { type: "text" }, size: { type: ["sm", "md", "lg"] } },
		children: "none",
		note: 'data=[{month:"Jan",sales:3}]; x is the label key, y one key or a list (default: every numeric key)',
	},

	Input: { props: { name: { type: "text", required: true }, label: { type: "text" }, placeholder: { type: "text" }, type: { type: ["text", "number"] }, value: { type: "value" } }, children: "none", declares: "name" },
	Select: { props: { name: { type: "text", required: true }, label: { type: "text" }, options: { type: "array", required: true }, value: { type: "value" } }, children: "none", declares: "name", note: "options: strings or {label,value}" },
	Choice: { props: { name: { type: "text", required: true }, label: { type: "text" }, options: { type: "array", required: true }, value: { type: "value" }, multiple: { type: "boolean" } }, children: "none", declares: "name", note: "segmented buttons, multiple holds a list" },
	Slider: { props: { name: { type: "text", required: true }, label: { type: "text" }, min: { type: "number" }, max: { type: "number" }, step: { type: "number" }, value: { type: "number" }, unit: { type: "text" } }, children: "none", declares: "name" },
	Toggle: { props: { name: { type: "text", required: true }, label: { type: "text" }, value: { type: "boolean" } }, children: "none", declares: "name" },
	Button: { props: { send: { type: "text" }, set: { type: "object" }, primary: { type: "boolean" }, disabled: { type: "boolean" } }, children: "text" },
};

/** Any element takes these. */
export const COMMON_PROPS: Record<string, PropSpec> = { when: { type: "value" } };
