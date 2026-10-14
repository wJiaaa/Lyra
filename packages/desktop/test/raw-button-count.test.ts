/**
 * `src/ui` 以外手写的 `<button>`，只许减少，不许增加。
 *
 * 按钮统一过两次。写 `Button` 时有 276 个手写的，之后又长回 307 个（按下面的数法）——组件在，
 * 但新代码没人拦着就不走它。第二次迁到 204 个；第三次给组件补上 `expanded`（原地展开，不是菜单）、
 * `pressed`（一组里选中的那个）、`ariaLabel`、20px 的 `xs` 和输入框底栏那一档尺寸，再把终端和文件的标签
 * 合成 `ClosableTab`，迁到 156 个；自动更新连同它的徽标删掉之后是 155 个；PR 账号、Git 面板导航、表格的 sheet 也改成 `pressed` 之后是 152 个；侧栏「显示更多」旁的收起改回手写（hover 只加深字色、不画底色，`Button` 的 subtle 会铺 `bg-card-hover`），是 153 个；模型设置页改成分组列表时，供应商名字本身成了改名入口、模型行左边那一整块（图标、名字、默认徽标）成了编辑入口——都是一段文字或一块区域的点击层，不是按钮的形状，在 152 的基础上是 154 个；设置导航底部的「引导」删掉之后是 153 个；任务面板「后台任务」的每一行成了展开输出的点击层（箭头、状态点、说明整段可点，`Button` 的定高和内衬会把行撑开），上限从 152 调到 153；按上游恢复移动端时带回了手机专用的底栏、抽屉头、上传条、底部弹层和同步设置页（`PhoneDock`、`SidebarHead` 的 `PhoneHead`、`PhoneUploads`、`PhoneSheet`、`SyncSettings`），照上游原样保留以便之后合并，是 166 个；合入上游的窗口外框时多了图标栏的 `RailButton`（向右的提示、`aria-current`、两种颜色的角标，以及 e2e 认的 `data-ly-open-settings`，`IconButton` 都没有），是 167 个；侧栏跟着图标栏换内容之后，拉取请求、定时任务、插件三页各自的侧栏共用一种整行的 `NavSlotRow`（图标、可截断的名字、右端的计数或状态点，选中铺底、停用变淡——和 `NavItem` 一样是列表行），是 168 个；侧栏删掉「项目 / 聊天」切换之后是 167 个；列表设置挪进分区标题、归档入口回到设置页之后是 166 个；撤掉手机端、改回 Web 访问时，上面那 13 个手机专用的按钮一起删掉，是 153 个。面板去掉分栏排法、拖动面板的抓手跟着删掉之后，是 152 个。工具卡片的结果区画出图片之后，每张缩略图本身是打开大图的点击层（形状就是那张图，`Button` 的定高和内衬会把它压扁），是 152 个。生成图片的工具行下面常驻一块画布，画好的图就是它，同样是打开大图的点击层，是 153 个。侧栏回到毛玻璃上、图标栏撤掉之后，`RailButton` 和三页侧栏共用的 `NavSlotRow` 一起删掉，是 151 个。自动更新恢复之后，侧栏底部的更新徽标回来了（它的宽度从圆点展开成一条带版本号的胶囊，进度环套在图标上，`Button` 的定高和内衬放不下），是 152 个。转录里连接中断那一行、审批卡片的标题栏原来只有末尾的箭头能点，改成图标、文字和箭头整段是一颗点击层（同「后台任务」那一行，`Button` 的定高和内衬会把行撑开），在当时 150 的基础上是 152 个。标题栏加了环境卡片：打开方式、后台任务、子 Agent、PR、侧边聊天、引用每一行都是共用 `ROW` 的整行点击层（8 个），引用里的缩略图是打开大图的点击层，「+N」格子、行尾的轮次标签、打开方式那颗 28px 宽的下拉箭头和摘要里文字式的「重试」都贴着行高或文字，`Button` 的定高和内衬放不下，是 165 个。计划模式开着时，输入框底栏那颗带字的强调色芯片（和权限芯片同一种文字触发器，`Button` 没有底栏那一档高度和强调色）是 166 个；划词引用的横排胶囊菜单两段是菜单项（`role="menuitem"`，中间一条线通到上下沿，`Button` 的定高和圆角会把它切成两颗），输入框上方那枚「N 条对话引用」是指上去就展开引文的胶囊（要 ref 给浮层定位、要 `onMouseEnter`/`onMouseLeave`，`Button` 都不透传），是 169 个。拉取模型弹窗改成能删能加之后，每一行的勾选和底部「添加这个模型」那一行是整行点击层，弹窗原来那两颗换掉了；生成的图悬停时压在图上的「编辑」「下载」是一层玻璃（黑底半透明加模糊，`Button` 没有这一种底色、也不收 `style`），打开大图的点击层从框里的按钮变成框里一层，是 172 个。移植上游的画廊之后，相册里的每一格、详情里的大图、生成链路的每一步都是整块点击层（形状就是那张图或那一行），对话标题是一段可点的文字，已标注缩略图角上那颗 16px 的「去掉标注」小于 `IconButton` 最小的一档，是 177 个。工作树按会话选之后多了三颗：输入框底栏那颗琥珀色的「工作树没建成」图标（和底栏其余控件同一档高度、同一个 `ly-composer-control`）、环境卡片里「建议的新会话」那一条（共用 `ROW` 的整行点击层）、转录里那行「建议了新会话」的记录（整行点击层，点开环境卡片里那一节），是 180 个。设置里「调用链」的展开 / 折叠两种排法合成一种、展开排法那张带框工具卡片的头一起删掉之后，是 179 个；一轮的过程改成挂在一行锚（「已工作 1 分 41 秒」）下面，锚是字在一条细线上的整行点击层（宽到整列、下沿那条线是它的一部分，`Button` 的定高和内衬放不下），是 180 个。剩下的多数是整行点击层、列表行、菜单项、深色浮层上的按钮、自带形状的
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

const CEILING = 180;

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
