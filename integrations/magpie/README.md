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

## 改完要重启 Plume

Plume 启动时读一次设置，之后以内存里那份为准。magpie 改了文件而 Plume 还开着，**先重启 Plume**；
否则在 Plume 里改任何一项设置都会用内存里的旧值写回去，magpie 写的键随之丢失，Agent 页上这一行显示为未接入。

插件机制见 magpie 文档：[插件开发 · Agent 插件](https://usemagpie.ai/docs/zh/plugins#agents)。
