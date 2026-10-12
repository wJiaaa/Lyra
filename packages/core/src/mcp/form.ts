/**
 * MCP elicitation 的表单：服务器发来的 `requestedSchema` 变成一排字段，人填的值按同一份字段检查。
 *
 * 规范只允许扁平的原始类型——string（可带 enum / oneOf / format）、number、integer、boolean——
 * 这里只认这几种。多选数组、嵌套对象一律当作不支持，整张表单拒掉，而不是画一张缺了几格的表：
 * 少一格的表单交回去，服务器收到的是一份它没要过的残缺答案。
 *
 * 纯函数、零依赖，浏览器能用（`@plume/core/mcp-form`）：窗口据此画每一格的错误提示，闸门据此在
 * 主进程里收答案，两边必须是同一个判断——窗口说填好了、闸门却拒收，比两边都不检查更糟。
 */

export type FormFieldType = "string" | "number" | "integer" | "boolean";

export interface FormField {
	name: string;
	/** 给人看的名字：schema 的 `title`，没有就用字段名。 */
	label: string;
	description?: string;
	required: boolean;
	type: FormFieldType;
	/** 单选：`enum`（可带 `enumNames`）或 `oneOf: [{ const, title }]`。 */
	options?: { value: string; label: string }[];
	format?: "email" | "uri" | "date" | "date-time";
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	default?: string | number | boolean;
}

export type FormValue = string | number | boolean;
export type FormValues = Record<string, FormValue>;
/** 一格为什么不能交：窗口按它说人话，闸门按它拒收。 */
export type FormProblem = "required" | "type" | "option" | "format" | "minLength" | "maxLength" | "minimum" | "maximum";

export class UnsupportedFormError extends Error {}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** 服务器要的那张表。看不懂的 schema 抛 `UnsupportedFormError`，说清楚是哪一格。 */
export function formFields(schema: unknown): FormField[] {
	const root = record(schema);
	if (!root || root.type !== "object") throw new UnsupportedFormError("requestedSchema must be an object schema");
	const properties = record(root.properties) ?? {};
	const required = Array.isArray(root.required) ? root.required.filter((name): name is string => typeof name === "string") : [];
	return Object.entries(properties).map(([name, raw]) => field(name, raw, required.includes(name)));
}

function field(name: string, raw: unknown, required: boolean): FormField {
	const schema = record(raw);
	if (!schema) throw new UnsupportedFormError(`field "${name}" has no schema`);
	const base = {
		name,
		label: typeof schema.title === "string" && schema.title ? schema.title : name,
		...(typeof schema.description === "string" && schema.description ? { description: schema.description } : {}),
		required,
	};
	if (schema.type === "boolean") return { ...base, type: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
	if (schema.type === "number" || schema.type === "integer") {
		return {
			...base,
			type: schema.type,
			...numberProp(schema, "minimum"),
			...numberProp(schema, "maximum"),
			...(typeof schema.default === "number" ? { default: schema.default } : {}),
		};
	}
	if (schema.type !== "string") throw new UnsupportedFormError(`field "${name}" has unsupported type ${JSON.stringify(schema.type)}`);
	const options = choices(name, schema);
	return {
		...base,
		type: "string",
		...(options ? { options } : {}),
		...(!options && typeof schema.format === "string" && FORMATS.has(schema.format) ? { format: schema.format as FormField["format"] } : {}),
		...(!options ? { ...numberProp(schema, "minLength"), ...numberProp(schema, "maxLength") } : {}),
		...(typeof schema.default === "string" ? { default: schema.default } : {}),
	};
}

function choices(name: string, schema: Record<string, unknown>): FormField["options"] | undefined {
	if (Array.isArray(schema.enum)) {
		const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
		return schema.enum.map((value, index) => {
			if (typeof value !== "string") throw new UnsupportedFormError(`field "${name}" has a non-string option`);
			const label = names[index];
			return { value, label: typeof label === "string" && label ? label : value };
		});
	}
	if (Array.isArray(schema.oneOf)) {
		return schema.oneOf.map((entry) => {
			const option = record(entry);
			if (!option || typeof option.const !== "string") throw new UnsupportedFormError(`field "${name}" has an option without a string const`);
			return { value: option.const, label: typeof option.title === "string" && option.title ? option.title : option.const };
		});
	}
	return undefined;
}

/** 一张表单的初始值：schema 给了默认值的用默认值，布尔格没给就是 false——复选框没有「没填」这种状态。 */
export function initialValues(fields: readonly FormField[]): Partial<FormValues> {
	const values: Partial<FormValues> = {};
	for (const one of fields) {
		if (one.default !== undefined) values[one.name] = one.default;
		else if (one.type === "boolean") values[one.name] = false;
	}
	return values;
}

/**
 * 交上来的值对不对得上表单。
 *
 * 只收表单里有的格；没填的可选格不交——交一个空字符串，服务器会当成人填了「空」。
 */
export function checkFormValues(fields: readonly FormField[], raw: unknown): { ok: true; values: FormValues } | { ok: false; problems: Record<string, FormProblem> } {
	const given = record(raw) ?? {};
	const values: FormValues = {};
	const problems: Record<string, FormProblem> = {};
	for (const one of fields) {
		const value = given[one.name];
		if (value === undefined || value === null || value === "") {
			if (one.required) problems[one.name] = "required";
			continue;
		}
		const problem = problemOf(one, value);
		if (problem) problems[one.name] = problem;
		else values[one.name] = value as FormValue;
	}
	return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, values };
}

function problemOf(one: FormField, value: unknown): FormProblem | null {
	if (one.type === "boolean") return typeof value === "boolean" ? null : "type";
	if (one.type === "number" || one.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value) || (one.type === "integer" && !Number.isInteger(value))) return "type";
		if (one.minimum !== undefined && value < one.minimum) return "minimum";
		if (one.maximum !== undefined && value > one.maximum) return "maximum";
		return null;
	}
	if (typeof value !== "string") return "type";
	if (one.options) return one.options.some((option) => option.value === value) ? null : "option";
	// 按字符数，不按 UTF-16 码元：JSON Schema 的 length 数的是字符，一个 emoji 算一个。
	const length = [...value].length;
	if (one.minLength !== undefined && length < one.minLength) return "minLength";
	if (one.maxLength !== undefined && length > one.maxLength) return "maxLength";
	if (one.format && !formatOk(one.format, value)) return "format";
	return null;
}

function formatOk(format: NonNullable<FormField["format"]>, value: string): boolean {
	if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	if (format === "uri") return /^[a-z][a-z0-9+.-]*:\S+$/i.test(value);
	if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function numberProp<K extends "minimum" | "maximum" | "minLength" | "maxLength">(schema: Record<string, unknown>, key: K): Partial<Record<K, number>> {
	const value = schema[key];
	return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Partial<Record<K, number>>) : {};
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
