import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { recordFileChange } from "../../core/src/tools/file-changes.ts";
import { collectDelivery, deliveryMessages } from "../electron/delivery-record.ts";
import type { Message, ToolContext } from "@plume/core";
let home: string, ctx: ToolContext, prior: string | undefined;
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),"plume-delivery-test-"));prior=process.env.PLUME_HOME;process.env.PLUME_HOME=home;const cwd=join(home,"project");await mkdir(cwd);ctx={cwd,sessionId:"qa",state:new Map(),scratchDir:join(home,"scratch")};});
afterEach(async()=>{if(prior===undefined)delete process.env.PLUME_HOME;else process.env.PLUME_HOME=prior;await rm(home,{recursive:true,force:true});});
function result(details: unknown): Message {return {role:"toolResult",toolName:"write",toolCallId:"tool",content:[],details,isError:false,timestamp:10};}
test("delivery reports the net file change and actual command evidence, with no report for ordinary chat",async()=>{
	const path=join(ctx.cwd,"index.ts");
	const one=await recordFileChange(ctx,path,null,"const x=1;\n"),two=await recordFileChange(ctx,path,"const x=1;\n","const x=2;\n");await writeFile(path,"const x=2;\n");
	const messages=[result({changeId:one}),result({changeId:two}),result({command:"node --test",exitCode:1})];
	const delivery=await collectDelivery(ctx.sessionId,ctx.cwd,messages,42);
	assert.equal(delivery.files.length,1);assert.equal(delivery.files[0].removed,0);assert.equal(delivery.files[0].canUndo,true);assert.equal(delivery.commands[0].status,"exit 1");
	assert.ok(delivery.reportPath);assert.match(await readFile(delivery.reportPath,"utf8"),/exit 1/);
	assert.equal((await collectDelivery(ctx.sessionId,ctx.cwd,[],43)).reportPath,null);
	const launched=await collectDelivery(ctx.sessionId,ctx.cwd,[result({kind:"bash_background",id:"owned-job",command:"node service.cjs"})],44);
	assert.deepEqual(launched.serviceJobIds,["owned-job"]);assert.equal(launched.reportPath,null);
	await writeFile(path,"user edited");assert.equal((await collectDelivery(ctx.sessionId,ctx.cwd,messages,42)).files[0].canUndo,false);
});

test("a delivery spans synthetic continuations but stops at the last real user request", () => {
	const assistant = (timestamp: number): Message => ({ role: "assistant", timestamp, api: "openai-responses", provider: "qa", model: "qa", content: [], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const user = (timestamp: number, synthetic = false): Message => ({ role: "user", timestamp, synthetic, content: [] });
	const messages = [user(1), assistant(2), user(3), result({}), assistant(4), user(5, true), result({}), assistant(6)];
	assert.deepEqual(deliveryMessages(messages, 6), messages.slice(2));
	assert.deepEqual(deliveryMessages(messages, 2), messages.slice(0, 2));
});
