/**
 * 主进程交给 core 的 `plume://` 文档目录，就是安装包放进去的那一份。
 *
 * 对不上时什么也不报：应用照常启动，只是 agent 一读 `plume://` 就说「这份安装没有带上使用说明」，
 * 然后回到去 grep `app.asar` 的老路上。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { bundledDocs } from "../electron/plume-docs.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const config = parse(readFileSync(join(desktop, "electron-builder.yml"), "utf8")) as { extraResources: { from: string; to: string; filter?: string[] }[] };

test("打包放的位置和主进程找的位置是同一个，开发时指回 core 的源码目录", () => {
	const entry = config.extraResources.find((resource) => resource.to === "plume-docs");
	assert.ok(entry, "extraResources 里没有 plume-docs");
	assert.ok(entry.filter?.includes("*.md"));
	assert.ok(existsSync(join(desktop, entry.from, "addresses.md")), `${entry.from} 下面没有文档`);

	assert.equal(bundledDocs({ packaged: true, appPath: "/app.asar", resourcesPath: "/res" }), join("/res", entry.to));
	assert.equal(bundledDocs({ packaged: false, appPath: desktop, resourcesPath: "" }), join(desktop, entry.from));
});
