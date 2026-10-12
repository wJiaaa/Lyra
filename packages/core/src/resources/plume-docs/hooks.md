# 钩子：支持哪些事件、配置写在哪、项目钩子为什么要先信任

钩子是在特定事件发生时自动运行的命令，写法和 Claude Code 的 hooks 基本一致。在「设置 › 钩子」里管理。

## 两个范围

页面左上角的胶囊选范围：「用户」，或某个项目。

- **用户**：存在 `~/.plume/settings.json` 的 `hooks` 里，对所有项目生效。
- **项目**：存在 `<项目>/.plume/config.json` 的 `hooks` 里，只对这个项目生效。这个文件会跟着仓库走。

点「新建钩子」填表：范围、事件、匹配器、运行方式（「Shell 命令」或「进程」）、命令；选 Shell 命令时还能指定 Shell、打开「后台运行」；「高级」里有超时时间、状态消息、自定义字段 JSON。改动下一轮就生效，不用重开会话。

## 支持的事件

`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure`、`SessionEnd`。

- `SessionStart` 在会话第一次发消息时跑，不是打开会话时。
- `StopFailure` 在一轮没有正常收尾时跑，`SessionEnd` 在会话被释放（删除、归档、退出应用等）时跑。这两个只观察，输出和退出码不影响任何事。
- 还没有 `SubagentStart` / `SubagentStop`。子智能体里的工具调用同样会触发 `PreToolUse` / `PostToolUse` 等，但子智能体不触发 `Stop`。

## 配置格式

注意事件外面多一层 `events`，这一点和 Claude Code 不同：

```json
{
  "hooks": {
    "events": {
      "PreToolUse": [
        { "matcher": "Bash|Write", "hooks": [{ "type": "command", "command": "./scripts/guard.sh", "timeout": 30 }] }
      ]
    }
  }
}
```

- `type: "command"` 交给 shell 执行，可写 `shell` 指定 shell、`async: true` 后台运行不等结果、`timeout`（秒）。`type: "process"` 直接起进程，`args` 是参数数组，超时写 `timeoutMs`（毫秒）。默认超时 60 秒。
- **匹配器**：留空或 `*` 匹配全部；只含字母、数字、`_` 和 `|` 时按名字精确匹配，多个用 `|` 隔开（如 `Bash|Edit`，不要用逗号）；其他写法按正则，例如 `mcp__.*` 匹配所有 MCP 工具。工具名大小写两种都认：`bash` 和 `Bash`、`edit` 和 `Edit` 都行。
- **输入**：事件内容以 JSON 从标准输入送进去（如 `tool_name`、`tool_input`）。环境变量有 `CLAUDE_PROJECT_DIR`、`PLUME_PROJECT_DIR`、`CLAUDE_SESSION_ID`、`PLUME_SESSION_ID`。
- **输出**：退出码 0 时读标准输出里的 JSON（`decision`、`reason`、`additionalContext`、`hookSpecificOutput.permissionDecision` 等），不是 JSON 就忽略；是 JSON 但带了不认识的顶层字段算失败。退出码 2 表示阻止，原因取标准错误。其他退出码记为失败，但不阻止。
- 多个钩子给出权限结论时取最严的：deny > ask > allow。命令要到沙箱外运行（提权）时，钩子的 allow 不算数，仍要你在卡片上批准；deny 照常生效。
- `Stop` 钩子要求继续并给出原因时，这一轮会接着跑，最多连续三次。

## 项目钩子要先信任

项目钩子可能是别人提交进仓库的，会以你的身份在本机、沙箱外运行，所以**信任之前不会运行**：

- 跑到未信任的钩子时只记一笔「已阻止」。输入框上方会出现「N 个项目钩子待审核，审核前不会运行」，点「去审核」。
- 在「设置 › 钩子」选中这个项目，逐条看命令，点「信任」。
- 信任按钩子内容的指纹记在 `~/.plume/hook-trust.json`（不进仓库）。命令、匹配器或事件改过，就要重新信任；只是开关一条已信任的钩子不用。
- 在设置页里亲手新建或修改的项目钩子自动算信任。

## 看钩子跑得怎样

回复下方的操作栏里有钩子图标，点开列出这一轮跑过的钩子和结果：运行中、已阻止、失败、已超时、已取消。子智能体里跑的钩子记在子智能体自己的面板里。
