"""
Harbor 自带的 opencode agent，多做两件事：换掉安装、把 key 交给它。

安装：Harbor 在每个容器里 apt → nvm → Node → npm 现装 opencode，模拟运行加上本机网络，一道题要装五六分钟，
常常撞上 360 秒的安装上限。这里改成把 `bench/run.ts` 下好的预编译二进制传进去，和 plume_agent.py 一样。

key：Harbor 只给它列出的几家供应商转发 key（deepseek、openai……），opencode-go 不在里面，跑起来就是
未登录。key 的变量名由 `bench/run.ts` 放在 PLUME_BENCH_KEY_ENV 里。用 scoped_exec_env 而不是
`--ae`：后者会原样写进结果目录的 config.json。
"""

from __future__ import annotations

import os
from pathlib import Path

from harbor.agents.installed.opencode import OpenCode

ARCHES = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}


class OpenCodeAgent(OpenCode):
    async def install(self, environment) -> None:
        machine = (await self.exec_as_agent(environment, "uname -m")).stdout.strip()
        arch = ARCHES.get(machine)
        if not arch:
            raise RuntimeError(f"opencode-eval: 不支持的架构 {machine}")
        archive = Path(os.environ["PLUME_EVAL_BUNDLE"]) / f"opencode-linux-{arch}-{self._version}.tgz"
        await environment.upload_file(archive, "/tmp/opencode.tgz")
        await self.exec_as_root(
            environment,
            "mkdir -p /tmp/opencode && tar -xzf /tmp/opencode.tgz -C /tmp/opencode "
            "&& install -m 755 /tmp/opencode/package/bin/opencode /usr/local/bin/opencode && rm -rf /tmp/opencode /tmp/opencode.tgz",
        )
        # 父类的 run 和取版本号都先 `. ~/.nvm/nvm.sh`，留一个空文件让它照常往下走。
        await self.exec_as_agent(environment, "mkdir -p ~/.nvm && touch ~/.nvm/nvm.sh && opencode --version")

    async def run(self, instruction, environment, context) -> None:
        name = os.environ["PLUME_BENCH_KEY_ENV"]
        with environment.scoped_exec_env({name: os.environ[name]}):
            await super().run(instruction, environment, context)
