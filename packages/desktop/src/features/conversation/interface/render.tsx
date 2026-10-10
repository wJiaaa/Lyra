/**
 * An interface block's markup to components: which component, with what, and whether at all.
 *
 * Props arrive already read against the catalog (`readProps`): evaluated, fitted to their types,
 * the unusable left out. A component here never sees a string where it wanted a list, so none of
 * them has to defend itself — what was wrong is reported to the model instead (`checkBlock`).
 */

import { Fragment, type ReactNode } from "react";
import { COMPONENTS, evaluate, readProps, text, type UiElement, type UiNode } from "@plume/core/ui-language";
import { Callout, Card, Divider, Grid, Heading, Progress, Row, Stack, Stat, Table, Tabs, type Tone, Words } from "./content.tsx";
import { Chart } from "./Chart.tsx";
import { ActionButton, ChoiceField, InputField, SelectField, SliderField, ToggleField } from "./controls.tsx";

export interface Scope {
	/** State, and inside an `Each` the item it is repeating for. */
	values: Readonly<Record<string, unknown>>;
	set: (values: Record<string, unknown>) => void;
	send: (text: string) => void;
	/** Whether a `send` button saying `text` now would say what it last said, with the same values. */
	isSent: (text: string) => boolean;
	/** The open tab of each unnamed `Tabs`, by its titles — see `BlockState.tabs`. */
	tabs: { get: (id: string) => string | undefined; set: (id: string, title: string) => void };
	/** How many cards this is inside: a card in a card has no frame of its own. */
	depth: number;
}

/** More rows than a reply should hold; past this an `Each` is a list for a table or a chart. */
const MAX_REPEAT = 200;

function wordsOf(nodes: UiNode[], values: Readonly<Record<string, unknown>>): string {
	return nodes
		.map((node) => (node.kind === "text" ? node.parts.map((part) => (typeof part === "string" ? part : part.expression ? text(evaluate(part.expression, values)) : "")).join("") : ""))
		.join("");
}

export function renderNodes(nodes: UiNode[], scope: Scope): ReactNode[] {
	return nodes.map((node, index) => (node.kind === "text" ? <Fragment key={index}>{wordsOf([node], scope.values)}</Fragment> : <Fragment key={index}>{renderElement(node, scope)}</Fragment>));
}

function renderElement(element: UiElement, scope: Scope): ReactNode {
	if (!COMPONENTS[element.name]) return null;
	const props = readProps(element, scope.values);
	if ("when" in element.props && !props.when) return null;
	const inner = (next: Scope = scope) => renderNodes(element.children, next);
	const words = () => wordsOf(element.children, scope.values);
	const tone = props.tone as Tone | undefined;
	const field = (name: string) => ({ value: scope.values[name], onChange: (value: unknown) => scope.set({ [name]: value }) });

	switch (element.name) {
		case "Stack":
			return <Stack gap={props.gap as string}>{inner()}</Stack>;
		case "Row":
			return <Row gap={props.gap as string} align={props.align as string}>{inner()}</Row>;
		case "Grid":
			return <Grid cols={props.cols as number} gap={props.gap as string}>{inner()}</Grid>;
		case "Card":
			return <Card title={props.title as string} subtitle={props.subtitle as string} nested={scope.depth > 0}>{inner({ ...scope, depth: scope.depth + 1 })}</Card>;
		case "Divider":
			return <Divider />;
		case "Tabs": {
			const tabs = element.children.filter((child): child is UiElement => child.kind === "element" && child.name === "Tab");
			const titles = tabs.map((tab) => String(readProps(tab, scope.values).title ?? ""));
			const name = props.name as string | undefined;
			// Unnamed tabs switch for the reader alone, and are kept apart from the state the block and the reply read.
			const id = titles.join("\u0001");
			return (
				<Tabs
					titles={titles}
					value={name ? String(scope.values[name] ?? "") : scope.tabs.get(id)}
					onChange={name ? (title) => scope.set({ [name]: title }) : (title) => scope.tabs.set(id, title)}
					render={(at) => renderNodes(tabs[at]?.children ?? [], scope)}
				/>
			);
		}
		case "Tab":
			// Outside `Tabs` it is a section with nothing to switch: draw what it holds.
			return <Stack>{inner()}</Stack>;
		case "Each": {
			const items = ((props.of as unknown[] | undefined) ?? []).slice(0, MAX_REPEAT);
			const as = (props.as as string | undefined) || "item";
			const index = props.index as string | undefined;
			return items.map((item, at) => <Fragment key={at}>{inner({ ...scope, values: { ...scope.values, [as]: item, ...(index ? { [index]: at } : {}) } })}</Fragment>);
		}
		case "Heading":
			return <Heading level={props.level as number}>{words()}</Heading>;
		case "Text":
			return <Words tone={props.tone as string} size={props.size as string}>{words()}</Words>;
		case "Badge":
			return <Words badge tone={tone}>{words()}</Words>;
		case "Callout":
			return <Callout tone={tone} title={props.title as string}>{inner()}</Callout>;
		case "Stat":
			return <Stat label={props.label as string} value={props.value} delta={props.delta} hint={props.hint as string} />;
		case "Progress":
			return <Progress value={props.value as number} max={props.max as number} label={props.label as string} tone={tone} />;
		case "Table":
			return <Table columns={props.columns as unknown[]} rows={props.rows as unknown[]} data={props.data as unknown[]} />;
		case "Chart":
			return <Chart kind={props.kind as string} data={props.data as unknown[]} x={props.x as string} y={props.y} unit={props.unit as string} size={props.size as string} />;
		case "Input":
			return <InputField {...field(props.name as string)} label={props.label as string} placeholder={props.placeholder as string} numeric={props.type === "number"} />;
		case "Select":
			return <SelectField {...field(props.name as string)} label={props.label as string} options={props.options as unknown[]} />;
		case "Choice":
			return <ChoiceField {...field(props.name as string)} label={props.label as string} options={props.options as unknown[]} multiple={props.multiple === true} />;
		case "Slider":
			return <SliderField {...field(props.name as string)} label={props.label as string} min={props.min as number} max={props.max as number} step={props.step as number} unit={props.unit as string} />;
		case "Toggle":
			return <ToggleField {...field(props.name as string)} label={props.label as string} />;
		case "Button": {
			const says = typeof props.send === "string" ? props.send.trim() : "";
			// A button that also sets state changes what is set, so pressing it again is not the same press.
			const sent = Boolean(says) && props.set === undefined && scope.isSent(says);
			return (
				<ActionButton
					primary={props.primary === true}
					sent={sent}
					disabled={props.disabled === true || (props.send === undefined && props.set === undefined)}
					onPress={() => {
						if (props.set) scope.set(props.set as Record<string, unknown>);
						if (says) scope.send(says);
					}}
				>
					{words()}
				</ActionButton>
			);
		}
		default:
			return null;
	}
}
