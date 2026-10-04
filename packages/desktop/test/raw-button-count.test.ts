/**
 * `src/ui` 以外手写的 `<button>`，只许减少，不许增加。
 *
 * 按钮统一过两次。写 `Button` 时有 276 个手写的，之后又长回 307 个（按下面的数法）——组件在，
 * 但新代码没人拦着就不走它。第二次迁到 204 个；第三次给组件补上 `expanded`（原地展开，不是菜单）、
 * `pressed`（一组里选中的那个）、`ariaLabel`、20px 的 `xs` 和输入框底栏那一档尺寸，再把终端和文件的标签
 * 合成 `ClosableTab`，迁到 156 个；自动更新连同它的徽标删掉之后是 155 个；PR 账号、Git 面板导航、表格的 sheet 也改成 `pressed` 之后是 152 个；侧栏「显示更多」旁的收起改回手写（hover 只加深字色、不画底色，`Button` 的 subtle 会铺 `bg-card-hover`），是 153 个；模型设置页改成分组列表时，供应商名字本身成了改名入口、模型行左边那一整块（图标、名字、默认徽标）成了编辑入口——都是一段文字或一块区域的点击层，不是按钮的形状，在 152 的基础上是 154 个；设置导航底部的「引导」删掉之后是 153 个；任务面板「后台任务」的每一行成了展开输出的点击层（箭头、状态点、说明整段可点，`Button` 的定高和内衬会把行撑开），上限从 152 调到 153；按上游恢复移动端时带回了手机专用的底栏、抽屉头、上传条、底部弹层和同步设置页（`PhoneDock`、`SidebarHead` 的 `PhoneHead`、`PhoneUploads`、`PhoneSheet`、`SyncSettings`），照上游原样保留以便之后合并，是 166 个。剩下的多数是整行点击层、列表行、菜单项、深色浮层上的按钮、自带形状的
 * 控件（开关、滑块、色块、拖拽柄）、输入框底栏的文字触发器，以及尺寸刻意对齐行高的（侧栏顶 28px、通知 18px）。
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

const CEILING = 166;

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
