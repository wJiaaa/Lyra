# 怎么写一个技能：放在哪、SKILL.md 怎么写、同名时谁生效

技能是一个目录，里面有一个 `SKILL.md`。自己写的放在这两处之一：

- `<项目>/.plume/skills/<名字>/` 只在这个项目里用，跟着仓库走
- `~/.plume/skills/<名字>/` 所有项目都能用，市场里装的技能也在这里

```markdown
---
name: pdf-extract           # 可省略，省略时取目录名。只能是小写字母、数字和连字符
description: 从 PDF 里抽取文本与表格。用户提到 PDF、扫描件、发票时用这个。
allowed-tools: [read, bash] # 可选。省略表示不限制
disable-model-invocation: false  # 可选。true 表示只能由人手动触发
---

正文就是给模型的指令。写清楚步骤，不要写背景介绍。
技能目录里的其他文件可以用 `skill://pdf-extract/<文件名>` 读到。
```

**`description` 是最重要的一行**——模型是靠读它来决定用不用这个技能的。
写「什么时候该用它」，不要写「它是什么」。它必填，最长 1024 个字符；短于 40 个字符会有警告，
因为通常说不清什么时候该用。

除了上面两处，Plume 还会读这些位置，同名时按这个顺序，靠前的生效：

1. `<项目>/.plume/skills/`
2. `~/.plume/skills/`
3. 已安装插件里的技能
4. `<项目>/.claude/skills/`（`~/.claude/skills/` 不读）
5. 从项目往上到仓库根每一层的 `.agent/skills/`、`.agents/skills/`，以及 `~/.agents/skills/`
6. 从过去的会话里总结、经你批准的技能

设置里可以给某个重名的技能指定用哪一份，这会盖过上面的顺序。
