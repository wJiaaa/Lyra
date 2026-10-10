/**
 * 复制一条带界面块的回复：块变成它画出来的样子，而不是一段标记。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { copyableReply, interfaceText } from "../src/features/conversation/interface/interface-text.ts";

const BLOCK = `<Card title="本周">
  <Grid cols={3}>
    <Stat label="访问" value="12,480" delta="+8%"/>
    <Stat label="退款" value={6} hint="都已处理"/>
  </Grid>
  <Tabs>
    <Tab title="渠道"><Table columns={["渠道","占比"]} rows={[["搜索",42],["a|b",3]]}/></Tab>
    <Tab title="趋势"><Chart data={[{d:"一",v:3},{d:"二",v:5}]} x="d"/></Tab>
  </Tabs>
  <Choice name="plan" label="方案" options={[{label:"专业版",value:"pro"},{label:"企业版",value:"team"}]} value="pro"/>
  <Slider name="seats" label="人数" value={5} unit=" 人"/>
  <Text when={seats > 6}>人多</Text>
  <Button send="就这个">就这个</Button>
</Card>`;

test("块写成文字：数字是「标签: 值」，表和图是 Markdown 表，标签页每页都在，按钮不在", () => {
	const out = interfaceText(BLOCK);
	assert.ok(out.startsWith("**本周**\n访问: 12,480 +8%\n退款: 6（都已处理）"), out);
	assert.ok(out.includes("**渠道**\n| 渠道 | 占比 |\n| --- | --- |\n| 搜索 | 42 |\n| a\\|b | 3 |"), "竖线转义，不多切一列");
	assert.ok(out.includes("**趋势**\n| d | v |\n| --- | --- |\n| 一 | 3 |"), out);
	assert.ok(out.includes("方案: 专业版") && out.includes("人数: 5 人"), "选项写它的显示名，滑块带单位");
	assert.ok(!out.includes("人多"), "when 不成立的不写");
	assert.ok(!out.includes("就这个"), "按钮不写");
	assert.ok(!out.includes("<"), "一个标签都不剩");
});

test("读者设过的值盖过初值，when 跟着变", () => {
	const out = interfaceText(BLOCK, { plan: "team", seats: 8 });
	assert.ok(out.includes("方案: 企业版") && out.includes("人数: 8 人") && out.includes("人多"), out);
});

test("回复里只换写完的界面块，其余原文不动；没有界面块的回复原样返回", () => {
	const reply = "看一下：\n\n```ui\n<Stat label=\"访问\" value=\"1\"/>\n```\n\n```ts\nconst a = 1;\n```\n\n完。";
	assert.equal(copyableReply(reply, null), "看一下：\n\n访问: 1\n\n```ts\nconst a = 1;\n```\n\n完。");
	const plain = "只有字。\n\n```ts\nx\n```";
	assert.equal(copyableReply(plain, null), plain);
	const open = "写到一半：\n\n```ui\n<Stat label=\"访问\"";
	assert.equal(copyableReply(open, null), open, "围栏没收口的不换");
});
