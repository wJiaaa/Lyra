/**
 * 界面块的语言：写到一半也能读、表达式不越出给它的值、写错的地方回报给模型。
 *
 * 规则性的代码，每条都对着一种会真的发生的输入：流式输出时停在标签中间、模型照 JS 习惯写的
 * `==`、从网页里读来的 `constructor`、记错的属性名。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parseExpression, text } from "../src/ui-language/expression.ts";
import { parseBlock, type UiElement } from "../src/ui-language/parse.ts";
import { checkBlock, initialState, readProps } from "../src/ui-language/check.ts";
import { COMPONENTS } from "../src/ui-language/catalog.ts";
import { interfaceBlocks, unfencedComponents, withInterfaceNotes } from "../src/ui-language/notes.ts";
import { buildPromptContext } from "../src/prompt/system.ts";
import { emptyUsage, type AssistantMessage, type Message, type Tool } from "../src/types.ts";

const run = (source: string, scope: Record<string, unknown> = {}) => {
	const parsed = parseExpression(source);
	assert.ok(parsed.ok, `${source}: ${parsed.ok ? "" : parsed.error}`);
	return evaluate(parsed.expression, scope);
};

test("表达式：优先级、三元、严格相等、字符串拼接", () => {
	assert.equal(run("1 + 2 * 3"), 7);
	assert.equal(run("(1 + 2) * 3"), 9);
	assert.equal(run("a > 3 ? 'big' : 'small'", { a: 5 }), "big");
	assert.equal(run("'0' == 0"), false, "== 是 ===：表单里 '0' 和 0 不是一回事");
	assert.equal(run("x != 'a'", { x: "a" }), false);
	assert.equal(run("'第 ' + n + ' 周'", { n: 3 }), "第 3 周");
	assert.equal(run("missing ?? 'none'"), "none");
	assert.equal(run("!done && n >= 2", { done: false, n: 2 }), true);
	assert.equal(run("-a.b[1]", { a: { b: [1, 4] } }), -4);
	assert.deepEqual(run("{seats, plan: 'pro'}", { seats: 3 }), { seats: 3, plan: "pro" });
});

test("表达式：只读给它的值，碰不到原型和全局", () => {
	assert.equal(run("a.constructor", { a: {} }), undefined);
	assert.equal(run("a['__proto__']", { a: {} }), undefined);
	assert.equal(run("s.constructor", { s: "x" }), undefined);
	assert.equal(run("list.map", { list: [1] }), undefined);
	assert.equal(run("globalThis"), undefined);
	assert.equal(run("process"), undefined);
	assert.equal(run("eval('1')"), undefined, "不在名单上的函数不调用");
	assert.equal(run("list.length + s.length", { list: [1, 2], s: "abc" }), 5);
	assert.equal(run("list[-1]", { list: [1, 2, 9] }), 9);
	assert.equal(parseExpression("a = 1").ok, false, "没有赋值");
	assert.equal(parseExpression("() => 1").ok, false, "没有函数");
});

test("表达式：函数名单", () => {
	assert.equal(run("sum(list)", { list: [1, 2, 3] }), 6);
	assert.equal(run("max(1, 7, 3)"), 7);
	assert.equal(run("avg([2, 4])"), 3);
	assert.equal(run("round(3.14159, 2)"), 3.14);
	assert.equal(run("fixed(2, 1)"), "2.0");
	assert.equal(run("len('四个字符')"), 4);
	assert.equal(run("join(['a', 'b'], ' / ')"), "a / b");
	assert.equal(text(undefined), "");
	assert.equal(text(Number.NaN), "");
});

const only = (source: string) => parseBlock(source).nodes[0] as UiElement;

test("标记：写完的画、没写完的扣着", () => {
	assert.deepEqual(parseBlock('<Card title="A"><Stat label="x" val').nodes.map((node) => node.kind === "element" && node.children.length), [0], "写到一半的标签整个不画");
	assert.equal(only('<Card title="A"><Text>hel').open, true);
	assert.deepEqual((only('<Card title="A"><Text>hel').children[0] as UiElement).children, [{ kind: "text", parts: ["hel"] }]);
	assert.equal(parseBlock('<Chart data={[{a: 1}, {a:').nodes.length, 0, "数据写到一半的图不画：画出来的会是另一张图");
	assert.deepEqual(only("<Text>共 {n} 个，还有 {m").children, [{ kind: "text", parts: ["共 ", { source: "n", expression: { kind: "name", name: "n" } }, " 个，还有 "] }]);
	assert.equal(parseBlock("<Text>a</Text><").nodes.length, 1, "最后一个 < 是标签的开头，不是字");
	assert.equal(parseBlock("<Text>a</Te").problems.length, 0);
});

test("标记：属性、文字和闭合", () => {
	const card = only(`<Card title="周报" subtitle='第 3 周'>
		<Toggle name="on" checked/>
		<Text>
			第一行
			第二行
		</Text>
	</Card>`);
	assert.equal(card.open, false);
	assert.deepEqual(card.props.title, { kind: "text", text: "周报" });
	assert.deepEqual((card.children[0] as UiElement).props.checked, { kind: "flag" });
	assert.deepEqual((card.children[1] as UiElement).children, [{ kind: "text", parts: ["第一行 第二行"] }], "缩进和换行按 JSX 收拢");
	assert.equal(card.children.length, 2, "标签之间的空白不是字");
	assert.equal((only("<Text>{a < b} 和 {b > a}</Text>").children[0] as { parts: unknown[] }).parts.length, 3, "表达式里的 < 不是标签");
	const mismatched = parseBlock("<Card><Row><Text>x</Card>");
	assert.match(mismatched.problems.join(), /<Row> was closed by <\/Card>/);
	assert.match(parseBlock("</Row>").problems.join(), /closes nothing/);
});

test("状态：每个输入的 name 是一个变量，从它的 value 开始", () => {
	const { nodes } = parseBlock(`
		<Slider name="seats" min={1} value={5}/>
		<Slider name="floor" min={2}/>
		<Toggle name="yearly"/>
		<Select name="plan" options={["a", "b"]} value="b"/>
		<Choice name="tags" options={["x"]} multiple/>
		<Tabs name="tab"><Tab title="概览"/><Tab title="明细"/></Tabs>`);
	assert.deepEqual(initialState(nodes), { seats: 5, floor: 2, yearly: false, plan: "b", tags: [], tab: "概览" });
});

test("属性按类型读：表达式求值、引号里的 {…} 填进去、用不了的不交给组件", () => {
	const element = only(`<Chart kind="bar" data={rows} unit="{u}/月" size="huge" x={1}/>`);
	assert.deepEqual(readProps(element, { rows: [{ a: 1 }], u: "元" }), { kind: "bar", data: [{ a: 1 }], unit: "元/月", x: "1" });
	assert.deepEqual(readProps(only('<Progress value="40" max={total}/>'), { total: 80 }), { value: 40, max: 80 });
	assert.deepEqual(readProps(only('<Toggle name="a" value="false"/>'), {}), { name: "a", value: false });
});

test("检查：说出哪个元素、哪个属性、怎么了", () => {
	const problems = checkBlock(`<Card title="x">
		<BarChart data={[]}/>
		<Chart data={[{a: 1}]} color="red" kind="donut"/>
		<Table rows="[[1]]"/>
		<Text>{total} 元</Text>
		<Slider name="n"/>
		<Text>{round(n) + pow(n)}</Text>
		<Tab title="孤儿"/>
		<Button>没用的按钮</Button>
	</Card>`);
	const said = problems.join("\n");
	assert.match(said, /Card > BarChart: not a component — did you mean Chart\?/);
	assert.match(said, /Card > Chart: has no prop "color"/);
	assert.match(said, /Chart: kind must be "bar" \| "line" \| "area" \| "pie", not "donut"/);
	assert.match(said, /Table: rows must be written as rows=\{…\}/);
	assert.match(said, /reads "total", which no input declares \(state: n\)/);
	assert.match(said, /calls pow\(\)/);
	assert.match(said, /Tab: must be directly inside Tabs/);
	assert.match(said, /Button: does nothing without send or set/);
	assert.match(checkBlock('<Stat label="缺 value"/>').join(), /Stat: needs value/);
	assert.equal(checkBlock(Array.from({ length: 12 }, (_, at) => `<Foo${at}/>`).join("")).length, 9, "最多八条，再多就让它重读说明");
});

test("检查：Each 的变量只在它里面有；写到一半时没闭合不算错", () => {
	assert.deepEqual(checkBlock(`<Each of={[1, 2]} as="row" index="i"><Text>{row} {i}</Text></Each>`), []);
	assert.match(checkBlock(`<Each of={[1]}><Text>{item}</Text></Each><Text>{item}</Text>`).join(), /reads "item"/);
	assert.deepEqual(checkBlock("<Card><Text>写到一半", false), []);
	assert.match(checkBlock("<Card><Text>写完了却没闭合").join(), /never closed/);
	assert.deepEqual(checkBlock('<Button send="选 {plan}" primary>好</Button><Select name="plan" options={["a"]}/>'), []);
});

const user = (text: string, synthetic = false): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...(synthetic ? { synthetic } : {}) });
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp: 1 }) as AssistantMessage;
const textOf = (message: Message | undefined) => message?.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") ?? "";

test("回报：问题接在下一句人话后面，同一份历史每次一样，没问题就原样", () => {
	const reply = assistant('看这个：\n\n```ui\n<Chart data={[{a: 1}]} colour="red"/>\n```\n\n还有一段');
	const history = [user("画个图"), reply, user("后台跑完了", true), user("好的")];
	const out = withInterfaceNotes(history);
	assert.notEqual(out, history);
	assert.equal(out[2], history[2], "runtime 自己说的话不是人在听");
	assert.match(textOf(out[3]), /^好的\n<env>\n.*界面块.*\n- Chart: has no prop "colour"/s);
	assert.equal(textOf(out[0]), "画个图");
	assert.deepEqual(withInterfaceNotes(history), out, "确定的：前缀缓存不被打断");
	assert.equal(history[3]!.content.length, 1, "不改原历史");
	const clean = [user("画"), assistant("```ui\n<Text>好</Text>\n```"), user("嗯")];
	assert.equal(withInterfaceNotes(clean), clean);
	assert.deepEqual(interfaceBlocks("````ui\na\n```\nb\n````\n```ts\nx\n```"), ["a\n```\nb"]);
});

test("回报：忘了 ```ui 围栏的组件被当成文字显示，下一轮告诉模型", () => {
	// 10-12 一次真实回复的形状：整块写在正文里，前后都没有围栏。
	const bare = assistant('挑一个：\n\n<Card title="选一个方向">\n  <Choice name="pick" options={["A","B"]}/>\n  <Row gap="sm">\n    <Button send="用 {pick}">就这个</Button>\n  </Row>\n</Card>');
	const out = withInterfaceNotes([user("给几个模板"), bare, user("嗯")]);
	assert.match(textOf(out[2]), /- <Card> <Choice> <Row>: outside a ```ui fence, shown as plain text/);
	assert.deepEqual(unfencedComponents("```tsx\n<Card title=\"x\"/>\n```\n~~~\n<Row/>\n~~~"), [], "代码围栏里引用的写法不算");
	assert.deepEqual(unfencedComponents("正文提到 <Card> 组件\n<div>html</div>\n<Cardboard/>\n    <Card/>"), [], "句中、HTML 标签、不在名单上的名字、缩进代码块都不算");
});

test("提示词：只有画得出界面块的端才有这一段，组件表就是检查用的那张", async () => {
	const base = { cwd: "/fixture", tools: [], skills: [], projectInstructions: [], platform: "darwin", modelName: "Fixture", isGitRepo: false };
	const without = await buildPromptContext(base);
	assert.ok(!without.systemPrompt.includes("Interface blocks"));
	const preview = { name: "preview" } as Tool;
	const withIt = await buildPromptContext({ ...base, tools: [preview] });
	const section = withIt.sections.find((part) => part.source === "interface");
	assert.ok(section);
	const body = withIt.systemPrompt.slice(section.start, section.end);
	for (const name of Object.keys(COMPONENTS)) assert.match(body, new RegExp(`\\n  ${name}\\(`), name);
	assert.ok(body.length < 3200, `每次请求都要付：${body.length} 字符`);
	assert.deepEqual(checkBlock(/```ui\n([\s\S]*?)\n```/.exec(body)![1]!), [], "示例自己得过检查");
});
