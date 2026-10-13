"""
Harbor 里的 Plume：在任务容器里跑一次 `plume --json <题目>`，判分交给题目自带的 verifier。

Node、打好包的 CLI 和 ripgrep 由 `bench/run.ts` 按架构各打成一个 tar.gz，每道题在安装阶段传进容器。
不在容器里现装：题目镜像不一定有 curl，网络也不一定通。也不挂载：Harbor 的远端环境挂不了本机目录。
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BUNDLE = "/opt/plume-eval"
# 设置里有 API key，所以 PLUME_HOME 放在 /logs 之外：/logs/agent 会整个同步回宿主机的结果目录。
PLUME_HOME = "/tmp/plume-eval-home"
RESOLVE = f"NODE={BUNDLE}/node; export PLUME_RIPGREP={BUNDLE}/rg PLUME_HOME={PLUME_HOME}"
ARCHES = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}


class PlumeAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "plume"

    def version(self) -> str | None:
        return os.environ.get("PLUME_EVAL_VERSION")

    async def install(self, environment: BaseEnvironment) -> None:
        machine = (await self.exec_as_agent(environment, "uname -m")).stdout.strip()
        arch = ARCHES.get(machine)
        if not arch:
            raise RuntimeError(f"plume-eval: 不支持的架构 {machine}")
        archive = Path(os.environ["PLUME_EVAL_BUNDLE"]) / f"plume-linux-{arch}.tar.gz"
        await environment.upload_file(archive, "/tmp/plume-eval.tar.gz")
        await self.exec_as_root(
            environment,
            f"mkdir -p {BUNDLE} && tar -xzf /tmp/plume-eval.tar.gz -C {BUNDLE} && rm /tmp/plume-eval.tar.gz && chmod -R a+rX {BUNDLE}",
        )
        await self.exec_as_agent(environment, f'{RESOLVE}; "$NODE" --version')
        # 不走 exec_as_agent：它在 debug 日志里记下整份 env，key 会跟着进结果目录。
        written = await environment.exec(
            f'umask 077; mkdir -p {PLUME_HOME} && printf "%s" "$PLUME_EVAL_SETTINGS" > {PLUME_HOME}/settings.json',
            env={"PLUME_EVAL_SETTINGS": os.environ["PLUME_EVAL_SETTINGS"]},
        )
        if written.return_code != 0:
            raise RuntimeError(f"plume-eval: 写不进设置：{written.stderr}")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # 没跑完（退出码 1）也照常交给 verifier 判：判分看的是容器里的结果，不是 Plume 自己怎么说。
        command = (
            f"{RESOLVE}; "
            f'"$NODE" {BUNDLE}/plume.mjs --json {shlex.quote(instruction)} '
            "> /logs/agent/plume.json 2> /logs/agent/plume.log </dev/null; "
            "echo $? > /logs/agent/exit-code"
        )
        try:
            await environment.exec(command)
        finally:
            # 超时被取消时也拷一份：那正是最想看轨迹的时候。设置文件不拷。
            await environment.exec(
                f"mkdir -p /logs/agent/plume-home && cp -R {PLUME_HOME}/sessions /logs/agent/plume-home/ 2>/dev/null; true"
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        output = self.logs_dir / "plume.json"
        try:
            usage = json.loads(output.read_text()).get("usage") or {}
        except (OSError, ValueError):
            return
        context.n_input_tokens = usage.get("input", 0) + usage.get("cacheRead", 0)
        context.n_output_tokens = usage.get("output", 0)
        context.n_cache_tokens = usage.get("cacheRead", 0)
        cost = (usage.get("cost") or {}).get("total")
        context.cost_usd = cost if cost else None
