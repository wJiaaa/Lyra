/**
 * 不在工具表上的工具（`mcp-search.ts`）调用前按 schema 查参数：服务商没见过它的 schema，替它约束
 * 参数的只剩这里。
 */

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { JsonSchema } from "../types.ts";

/**
 * 返回一句说哪里不对的话；对得上返回 undefined。
 *
 * 用 MCP SDK 自带的 ajv（它校验 `outputSchema` 用的就是这一个）。schema 编译不了的不拦：那是工具
 * 定义的问题，调用交给工具自己去判。
 *
 * 比 JSON Schema 默认更严一处：顶层出现 schema 里没有的参数名就拦下。工具表里的工具有服务商按
 * schema 约束参数名，这条路没有；模型把 `team` 写成 `teamId`，服务器多半默默忽略，调用「成功」了，
 * 做的却不是要的事。schema 明说接受任意参数（`additionalProperties` 为 true 或 schema）的不拦。
 */
export function schemaProblem(schema: JsonSchema, args: Record<string, unknown>): string | undefined {
	const properties = schema.properties;
	const open = schema.additionalProperties === true || (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null);
	if (properties && Object.keys(properties).length > 0 && !open) {
		const unknown = Object.keys(args).filter((key) => !(key in properties));
		if (unknown.length > 0) return `not parameters of this tool: ${unknown.join(", ")}; it takes ${Object.keys(properties).join(", ")}`;
	}
	const check = validatorFor(schema);
	if (!check) return undefined;
	const result = check(args);
	return result.valid ? undefined : result.errorMessage;
}

const validators = new WeakMap<object, JsonSchemaValidator<unknown> | null>();
let ajv: AjvJsonSchemaValidator | undefined;

function validatorFor(schema: JsonSchema): JsonSchemaValidator<unknown> | undefined {
	const known = validators.get(schema);
	if (known !== undefined) return known ?? undefined;
	let made: JsonSchemaValidator<unknown> | null;
	try {
		ajv ??= new AjvJsonSchemaValidator();
		made = ajv.getValidator(schema as never);
	} catch {
		made = null;
	}
	validators.set(schema, made);
	return made ?? undefined;
}
