/** Does a sub-agent actually run on the model its definition asked for? */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentProfile } from "../../packages/core/src/config/model-roles.ts";
import { DEFAULT_SETTINGS, loadSettings, resolveModel } from "../../packages/core/src/config/settings.ts";
import { runSubAgent } from "../../packages/core/src/runtime/sub-agent.ts";
import { readTool } from "../../packages/core/src/tools/read.ts";

const say = (s = "") => process.stderr.write(s + "\n");

/*
 * The parent runs on Plume's default model and `@fast` on whatever this machine calls fast;
 * either can be named on the command line instead: `model-role-eval.ts [parent] [fast]`.
 */
const loaded = await loadSettings();
const parentId = process.argv[2] ?? loaded.defaultModelId ?? "";
const fastId = process.argv[3] ?? agentProfile(loaded, "fast").modelId ?? "";
const parent = resolveModel(loaded, parentId);
const fast = resolveModel(loaded, fastId);
if (!parent || !fast) throw new Error(`需要两个模型：父会话 ${parentId || "（没有默认模型）"}，@fast ${fastId || "（设置里没配 fast）"}`);

const cwd = await mkdtemp(join(tmpdir(), "role-"));
await writeFile(join(cwd, "a.txt"), "内容一\n内容二\n", "utf8");

const settings = {
  ...DEFAULT_SETTINGS,
  // Both providers: `@fast` may live somewhere other than the parent's model.
  providers: [...new Map([parent.provider, fast.provider].map((provider) => [provider.id, provider])).values()],
  mcpServers: [],
  permissionMode: "full" as const,
  // `@fast` reads the sub-agent profile named `fast` (`agentProfile`).
  subAgentProfiles: { fast: { modelId: fast.model.id } },
};

for (const [label, def] of [
  ["没声明 model（应该跟父一样）", { name: "plain", description: "d", systemPrompt: "读文件并汇报。", tools: ["read"], source: "builtin" as const }],
  ["声明 @fast", { name: "quick", description: "d", systemPrompt: "读文件并汇报。", tools: ["read"], source: "builtin" as const, model: "@fast" }],
  ["声明一个不存在的 → 回落", { name: "gone", description: "d", systemPrompt: "读文件并汇报。", tools: ["read"], source: "builtin" as const, model: ["@deep", "relay/does-not-exist"] }],
] as const) {
  let used = "";
  await runSubAgent(
    {
      sessionId: "role", cwd, settings, tools: [readTool] as never[], skills: [], agents: [def as never],
      requestApproval: async () => "always",
      /*
       * `subagent_message`, not `message_end`.
       *
       * `message_end` is emitted inside `runTurn` and reaches the callback passed to it, not the
       * options.emit handed to `runSubAgent`. Listening to the wrong one reads as every case
       * failing, which is what it did.
       */
      emit: async (e: { type: string; message?: { model?: string } }) => {
        if (e.type === "subagent_message" && e.message?.model) used = e.message.model;
      },
    },
    { description: "读", prompt: "读 a.txt，一句话说里面是什么。", agentType: def.name },
    parent.provider, parent.model, "",
  );
  const expected = label.includes("@fast") ? fast.model.modelId : parent.model.modelId;
  say(`  ${label.padEnd(28)} 实际用了 ${used.padEnd(24)} ${used === expected ? "\x1b[32m✓\x1b[0m" : `\x1b[31m✗ 应该是 ${expected}\x1b[0m`}`);
}
say(`\n  父会话的模型是 ${parent.model.modelId}，@fast 配成了 ${fast.model.modelId}`);
