/**
 * The page-side `plume` API, behind `plume://preview`.
 *
 * Out of the tool description because most pages never call it — of 27 pages written in real
 * sessions, `plume.tweak` was used by none and `send`/`state` by two each — while the description
 * goes out with every request of every desktop session.
 */
export function previewReference(): string {
	return `# 网页预览（preview）里能调用的接口

页面里有一个全局对象 \`plume\`，用它让页面和对话来回传东西。

## 按钮替用户回答：\`plume.send(text)\`

在按钮的点击处理里调用，\`text\` 会作为用户的下一条消息发给你。把用户选了什么写进去（"Plan B, 12 seats, yearly"），这样你拿到就能直接动手，不用再问。

- 只在用户按下时才算数：页面加载时、定时器里、输入框变化时调用都不发。
- 在没有对话的地方（侧边面板）返回 \`false\`。

## 记住用户设过的东西：\`plume.state\` 与 \`plume.setState(value)\`

- \`plume.state\` 是页面上次保存的值，第一次打开时是 \`null\`。
- \`plume.setState(value)\` 保存一份 JSON，最多 16 KB。
- 用户一改（选了一项、拖了滑块）就保存，页面启动时从 \`plume.state\` 恢复，下次打开就是他离开时的样子。
- 用户改了什么，会在他下一条消息之后以 \`<page-state>\` 传给你。

## 给设计稿加调节旋钮：\`plume.tweak({ label, onChange })\`

页面是一个用户可能想微调的设计（组件、卡片、布局）时，把可调的参数交给他。\`plume.tweak\` 返回一个分组，分组上有：

- \`.slider(obj, key, { label, min, max, step, unit })\`
- \`.color(obj, key, { label })\`：值是 \`#rrggbb\`
- \`.toggle(obj, key, { label })\`
- \`.select(obj, key, { label, options })\`

每个控件绑定 \`obj[key]\`，一个分组最多 12 个。面板由应用来画；控件一动，应用就改掉那个属性并调用 \`onChange\`，所以 \`onChange\` 只做一件事：按 \`obj\` 重画。用户最后定下来的值会以 \`<design-settings>\` 传给你，由你写回页面里。
`;
}
