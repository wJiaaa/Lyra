/**
 * 另一个 Plume 进程：`mcp-oauth-refresh.test.ts` 起两个它，在同一刻去碰同一个 vault。
 *
 * 用法：`node mcp-oauth-child.ts vault <前缀>` 连写十五条；`node mcp-oauth-child.ts refresh <服务器 JSON>`
 * 取一次令牌（快过期时会提前刷新），把拿到的访问令牌打到 stdout。两个子进程都等到 `START_AT`
 * 那一毫秒才动手，尽量撞在一起。
 */

import { putSecrets } from "../src/config/vault.ts";
import { BackgroundOAuthProvider } from "../src/mcp/oauth.ts";
import type { McpHttpServer } from "../src/mcp/types.ts";

const [mode, arg] = process.argv.slice(2);
const start = Number(process.env.START_AT ?? 0);
while (Date.now() < start) await new Promise((resolve) => setTimeout(resolve, 1));

if (mode === "vault") {
	for (let i = 0; i < 15; i++) await putSecrets({ [`${arg}-${i}`]: `value-${i}` });
} else if (mode === "refresh") {
	const provider = await BackgroundOAuthProvider.for(JSON.parse(arg!) as McpHttpServer);
	const tokens = await provider.tokens();
	process.stdout.write(tokens?.access_token ?? "none");
}
