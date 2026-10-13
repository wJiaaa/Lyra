/**
 * MCP 服务器的 `inputSchema` 变成工具参数之前要过的那一道。
 *
 * 服务器的 schema 是写给它自己的校验器的，而每家服务商只接受 JSON Schema 的一个子集。工具表每轮都随请求
 * 发出去，一处服务商不认的写法就让所有会话的每一轮都失败——人也不会把它和自己装过的那台服务器联系起来。
 * 只对某一家成立的裁剪留在各自的适配器里（Anthropic 的 `normalizeToolSchema`）；这里只放对谁都安全的。
 */

import { isPlainObject } from "../ai/tool-schema.ts";
import type { JsonSchema } from "../types.ts";

/** 值是一个或一组子 schema 的关键字。 */
const SUBSCHEMAS = ["items", "prefixItems", "additionalProperties", "anyOf", "oneOf", "allOf", "not"] as const;
/** 值是「名字 → 子 schema」的关键字。 */
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** 缺省或不是 object 的 schema 换成空的 object schema：服务商都要求顶层是 object。 */
export function normalizeInputSchema(schema: unknown): JsonSchema {
	if (isPlainObject(schema) && schema.type === "object") return fillArrayItems(schema, new WeakMap()) as JsonSchema;
	return { type: "object", properties: {}, additionalProperties: true };
}

/*
 * 没写 `items` 的数组补上 `items: {}`。
 *
 * JSON Schema 允许裸的 `{"type":"array"}`（元素任意），MCP 服务器也常这么写；Gemini 的函数声明不允许。
 * 中转按 protobuf 的 `parameters` 字段转发时（CliRelay 的 Antigravity 渠道就是），一个这样的参数就让请求 400：
 * "...parameters.properties[machineIds].items: missing field."。`{}` 就是「任意值」，对本来就接受裸数组的
 * 服务商没有任何变化。
 *
 * 不补 `{"type":"string"}`（CLIProxyAPI 是这么补的）：那会把对象数组说成字符串数组，模型就照着传字符串。
 *
 * 返回副本而不是就地改：解析出来的 `tools/list` 结果归 SDK 所有。
 */
function fillArrayItems(schema: unknown, seen: WeakMap<object, unknown>): unknown {
	if (!isPlainObject(schema)) return schema;
	const already = seen.get(schema);
	if (already !== undefined) return already;
	const result: Record<string, unknown> = { ...schema };
	seen.set(schema, result);

	const visit = (value: unknown): unknown => (Array.isArray(value) ? value.map((child) => fillArrayItems(child, seen)) : fillArrayItems(value, seen));
	for (const key of SUBSCHEMAS) if (result[key] !== undefined) result[key] = visit(result[key]);
	for (const key of SUBSCHEMA_MAPS) {
		const children = result[key];
		if (isPlainObject(children)) result[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, fillArrayItems(child, seen)]));
	}

	const type = result.type;
	const isArray = type === "array" || (Array.isArray(type) && type.includes("array"));
	if (isArray && result.items === undefined) result.items = {};
	return result;
}
