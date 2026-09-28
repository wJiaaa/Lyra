/**
 * `src/ui` 以外手写的 `<button>`，只许减少，不许增加。
 *
 * 按钮统一过两次。写 `Button` 时有 276 个手写的，之后又长回 307 个（按下面的数法）——组件在，
 * 但新代码没人拦着就不走它。第二次迁到 204 个：剩下的多数是整行点击层、标签页、菜单项、输入框里
 * 的控件、深色浮层上的按钮；也有几处带 `aria-expanded` 的展开按钮、以及尺寸刻意对齐行高的，要单独讨论。
 * 这条测试把这个数钉住。
 *
 * 新写一个按钮时，先用 `ui/primitives` 的 `Button` / `IconButton`。确实不合适（上面那几类），
 * 把 `CEILING` 调高，并在提交说明里写原因。迁掉一个之后把 `CEILING` 调低——不调低，省下的
 * 余量会被下一个随手写的按钮悄悄用掉。
 *
 * 只数 `<button` 后面跟空白的写法：JSX 里的按钮都带属性，注释里提到的 `` `<button>` `` 不算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CEILING = 199;

test("src/ui 以外手写的 <button> 不超过上限，且上限跟着迁移往下调", async () => {
	const root = fileURLToPath(new URL("../src", import.meta.url));
	const counts = new Map<string, number>();
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
		const path = relative(root, join(entry.parentPath, entry.name));
		if (path.startsWith("ui/") || path.startsWith("ui\\")) continue;
		const n = (await readFile(join(root, path), "utf8")).match(/<button(?=\s)/g)?.length ?? 0;
		if (n > 0) counts.set(path, n);
	}
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

	assert.ok(
		total <= CEILING,
		`手写的 <button> 从 ${CEILING} 个变成 ${total} 个。先用 src/ui/primitives 的 Button / IconButton；` +
			`确实不适合就把 CEILING 调到 ${total} 并写明原因。`,
	);
	assert.equal(total, CEILING, `手写的 <button> 少到了 ${total} 个，把 CEILING 调到 ${total}，别让余量留着。`);
});
