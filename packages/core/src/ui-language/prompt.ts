/**
 * What the model is told about interface blocks: a short section of the system prompt, and the
 * full reference behind `plume://ui`, built from the catalog so the list it is taught is the list
 * that is drawn.
 *
 * The section is paid for on every request of every session that has it, cached or not; the
 * reference only when a block is about to be written. One line per component, props by name; a
 * type only where the name does not already say it.
 */

import { COMPONENTS, type PropSpec } from "./catalog.ts";
import { FUNCTIONS } from "./expression.ts";

function prop(name: string, spec: PropSpec): string {
	const shown = typeof spec.type === "string" ? name : `${name}:${spec.type.join("|")}`;
	return spec.required ? `${shown}*` : shown;
}

function line(name: string): string {
	const spec = COMPONENTS[name]!;
	const props = Object.entries(spec.props).map(([key, value]) => prop(key, value));
	return `${name}(${props.join(" ")})${spec.note ? ` — ${spec.note}` : ""}`;
}

const GROUPS: [string, string[]][] = [
	["Layout", ["Stack", "Row", "Grid", "Card", "Divider", "Tabs", "Tab", "Each"]],
	["Content", ["Heading", "Text", "Badge", "Callout", "Stat", "Progress", "Table", "Chart"]],
	["Inputs", ["Input", "Select", "Choice", "Slider", "Toggle", "Button"]],
];

/** `preview`: whether the session has the tool, so whole pages can be pointed at it. The side chat has not. */
export function interfacePrompt({ preview = true }: { preview?: boolean } = {}): string {
	return `

Interface blocks:
A reply can draw a small native interface in place: a \`\`\`ui fenced block, rendered with the app's own controls and theme as you write it. Use one when the answer is easier to use than to read — figures side by side, a chart, options to pick from, a form whose answer comes back to you. Prose stays prose and tables of text stay Markdown${preview ? "; a page that needs its own scripts or styling is `preview`'s job" : ""}.
The markup is its own small language, not HTML or React: before writing a block, read \`plume://ui\` for the syntax and the components — a \`plume://\` topic meant to be read in the middle of other work. What does not draw is reported on your next turn.`;
}

export function interfaceReference(): string {
	return `# 界面块（\`\`\`ui）的写法

- Markup is JSX-like, no JavaScript: <Name prop="text" prop={expression} flag>children</Name>, or <Name/>. Text and quoted props may hold {expression}. Write top-down; finished tags appear as you write them.
- Expressions: numbers, "strings", [arrays], {objects}, + - * / %, == != < <= > >=, && || ! ??, a ? b : c, a.b, a[i]. Functions: ${Object.keys(FUNCTIONS).join(" ")}.
- State: each input's name is a variable, starting at its value. Any element takes when={expression} to show only while it is true.
- <Button send="…">label</Button> sends that text as the user's next message, with every named value attached, so you get what they chose. set={{name: expression}} changes state without sending.
- No pixel sizes or styles: it lays itself out for the width it gets. * marks a required prop.

${GROUPS.map(([group, names]) => `${group}:\n${names.map((name) => `  ${line(name)}`).join("\n")}`).join("\n")}

Example:
\`\`\`ui
<Card title="Plan">
  <Slider name="seats" label="Seats" min={1} max={50} value={5}/>
  <Stat label="Monthly" value={"$" + seats * 12}/>
  <Button send="Go with {seats} seats" primary>Choose</Button>
</Card>
\`\`\``;
}
