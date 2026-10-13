# 评测：Terminal-Bench 2.1

回答「Plume 的 agent 够不够好、这次改动让它变好还是变坏」，用的是别人出的题和别人写的判分：
[Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1) 的 89 道题，每道题一个
Docker 容器，跑完由题目自带的测试判过或不过，不经过任何模型的判断。驱动它的是
[Harbor](https://pypi.org/project/harbor/)。

题目版本和 Harbor 版本锁得和 maka 公布成绩时一样（见 `run.ts` 顶上），opencode 在同一套题上的数可以
拿来对照——但只在同一台机器上跑出来的才能直接比，原因见下面「读数之前」。

## 跑

需要 Docker 和 [uv](https://docs.astral.sh/uv/)。第一次运行会把 Harbor、题目、Linux 版 Node 和 ripgrep
备到 `~/.cache/plume-eval/`（`PLUME_EVAL_CACHE` 可改），之后复用。

```bash
# 先跑一道确认链路是通的
pnpm bench --model provider-xxx/deepseek-flash -- -i fix-git -n 1

# 全量，思考档位写死，4 个并发
pnpm bench --model provider-xxx/deepseek-flash --thinking max -- -n 4

# 对照组：同一个模型、同一个 key，交给 opencode
pnpm bench --model provider-xxx/deepseek-flash --thinking max --agent opencode --opencode-provider deepseek -- -n 4
```

- Plume 的 CLI、Node、ripgrep 按架构打成一个约 46MB 的包，每道题在安装阶段传进容器，不计入答题时间。
  对照组的 opencode 也一样：锁定版本的预编译二进制第一次从 npm 下到 `bundle/`，之后复用，不在容器里现装。
- `--model` 是桌面端设置里的模型 id，key 从 vault 取，经环境变量进容器，不落盘、不进结果目录。
- `--` 之后原样交给 `harbor run`：`-i <题名>` 选题（可用通配），`-l 5` 只跑前 5 道，`-n` 并发数。
- 每次都会重新打包当前工作区的 CLI，结果里的 agent 版本是 `git describe --dirty`。

## 算分

```bash
pnpm bench:summary <plume 的 job> [<补跑的 job>...] <opencode 的 job>
```

**不要直接用 Harbor 打印的 Mean。** 判分脚本要先从网上装 uv、Python 和 pytest，装不上时测试根本没
跑，却照样记 0 分，和 agent 做错了分不开。汇总脚本把这种题算作「未判分」（0 分且没有
`verifier/ctrf.json`），并打印补跑用的 `-i` 列表。把补跑的 job 一起传进来，每道题取最早一次判了分的。
传入两个 agent 的结果时，还会按题配对，给出只有一边过的题和 McNemar 检验的 p 值。

## 结果在哪

`~/.cache/plume-eval/jobs/<job 名>/`：

- `result.json`：Harbor 自己的汇总，未判分的题也算进了分母
- `<题名>__<id>/agent/plume.log`：工具调用一行一条，`plume.json`：最终回答、状态、用量和花费
- `<题名>__<id>/agent/plume-home/`：这道题的会话库，`PLUME_HOME=<这个目录> pnpm dump:session` 可以倒出轨迹
- `<题名>__<id>/verifier/test-stdout.txt`：判分测试的输出，没过时先看这里

`harbor view ~/.cache/plume-eval/jobs` 可以在浏览器里翻。

## 读数之前

- **只比同一台机器上跑出来的。** 题目镜像都是 amd64，在 Apple Silicon 上是模拟运行，命令慢，
  超时的题会比在 x86 Linux 上多。maka 公布的分数是在 x86 上跑的，不能拿来直接比。
- **89 道题跑一次，分辨不出小差距。** maka 的报告里算过：差距小于 13 道左右时，单次运行看不出是
  真差别还是波动。改了一句提示词多过两三道，不能当成变好了。要看小改动，就挑相关的几道题重复跑
  （`-k` 每题跑几次）。
- **它测的是 core 的 agent 循环**：读文件、跑命令、改代码、知道什么时候停。桌面端的界面和交互
  不在这里面。
- **改了循环、截断、停止条件，改前改后各跑一遍**，和 `pnpm audit:sessions` 一起看。
