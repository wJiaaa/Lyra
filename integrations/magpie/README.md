# Plume 的 magpie Agent 插件

把 Plume 放进 [magpie](https://usemagpie.ai) 的 Agent 页：在 Plume 那一行选一个 magpie 的模型，
Plume 的新会话就走 magpie 的网关，用量记在 Plume 名下。

```sh
magpie plugin add ./integrations/magpie
```

也可以在 magpie 应用的「设置 → 插件」里添加这个文件夹。

## magpie 写了什么

选中模型后，magpie 原地改 `~/.plume/settings.json` 里的这几个键，其他设置不动：

```json
{
  "defaultModelId": "magpie/cliproxyapi/gpt-6-luna",
  "magpie": {
    "baseUrl": "http://127.0.0.1:3425",
    "apiKey": "magpie-plume",
    "models": [{ "id": "cliproxyapi/gpt-6-luna", "name": "GPT-6 Luna", "context": 1000000, "output": 128000, "images": true, "efforts": ["low", "medium", "high"] }]
  }
}
```

Plume 读设置时把 `magpie` 块合成一个名为「Magpie」的供应商，排在你自己的供应商后面
（`packages/core/src/config/magpie.ts`）。它不写进 `providers`，key 也不进 vault，开关全由 magpie 管：

- 在 magpie 里选回 Plume 原来的模型，或关掉开关，这几个键恢复原值，原本没有的删掉
  （删空的 `magpie` 会留成 `{}`，Plume 当它不存在）。
- 在 Plume 设置页里改这个供应商不会保存，下次启动又按 `magpie` 块重建。

## 资源库：技能、全局指令和 MCP

插件声明了三种资源的接收位置，模型是否走 Magpie 不影响资源库：

| 资源 | Magpie 写到哪里 | Plume 何时读取 |
| --- | --- | --- |
| 技能 | `~/.plume/skills/` | 按现有技能发现流程加载；新会话会读取 |
| 全局指令 | `~/.plume/magpie/AGENTS.md` | 每轮读取，与设置里的个人指令一起生效 |
| MCP | `~/.plume/magpie/mcp.json` | 启动时读取，修改后重启 Plume |

在 Magpie 资源库中选择 Plume，即可分发这些资源。需要支持 `agent.library` 的 Magpie 版本；旧版本请先更新。

MCP 文件使用 Claude 格式的 `mcpServers` 对象，支持 stdio、HTTP 和 SSE，以及环境变量和请求头里的 `${NAME}` 占位符。Plume 为这些服务加 `magpie__` ID 前缀，设置页标明「由 Magpie 管理」，配置、启停和移除在 Magpie 中进行；连接状态、工具列表、重连和 OAuth 登录仍可在 Plume 中查看或操作。缺少的密钥在 Magpie 中填写。

Plume 不把分发的指令和 MCP 配置另存进 `settings.json`，所以在 Magpie 中撤回后不会留下副本。已有手动配置保留；同名服务以不同 ID 共存，完整 ID 冲突时保留用户自己的服务并记录警告。格式损坏或无效的 MCP 条目会记录警告并跳过，原文件不被改写。

这些位置基于默认的 `~/.plume`。使用自定义 `PLUME_HOME` 时，需把插件的 `dir`、`config` 和 `library` 路径一起改为对应的绝对路径。

## 改完要重启 Plume

Plume 启动时读一次设置，之后以内存里那份为准。magpie 改了文件而 Plume 还开着，**先重启 Plume**；
否则在 Plume 里改任何一项设置都会用内存里的旧值写回去，magpie 写的键随之丢失，Agent 页上这一行显示为未接入。

插件机制见 magpie 文档：[插件开发 · Agent 插件](https://usemagpie.ai/docs/zh/plugins#agents)。
