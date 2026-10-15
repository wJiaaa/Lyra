/**
 * 子智能体的结果送回来的那一行，和子智能体要授权时那张卡。
 *
 * 两样都是「说清楚是谁」：送达那条消息是写给模型的，原样画出来会是一大段人自己没说过的话；授权卡
 * 从前说不出是谁在要——而后台可能同时有四个在跑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";

import { DeliveryRow } from "../../src/features/conversation/DeliveryRow.tsx";
import { ApprovalOverlay } from "../../src/features/conversation/ApprovalOverlay.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { useApp } from "../../src/store/index.ts";
import { useSubAgents } from "../../src/store/subAgents.ts";
import { mount } from "../helpers/mount.ts";

test("一个的结果回来：一行题注「消息来自 @谁」，带着它的任务，点一下面板翻到它", async () => {
	useApp.setState({ activeSessionId: "s" });
	const view = await mount(h(DeliveryRow, { delivery: [{ id: "s:sub:1", agent: "review", description: "审查登录模块", status: "done" }] }));
	try {
		const row = view.find<HTMLButtonElement>("[data-delivery-row] button");
		assert.match(row.textContent ?? "", /消息来自 @review/);
		assert.match(row.textContent ?? "", /审查登录模块/);
		assert.doesNotMatch(row.textContent ?? "", /出错/, "做完的不标");
		assert.equal(view.all("[data-delivery-row] .ly-avatar").length, 1, "它的脸");
		await act(async () => {
			row.click();
		});
		assert.equal(useSubAgents.getState().revealed?.id, "s:sub:1", "面板翻到它那一页");
	} finally {
		await view.unmount();
	}
});

test("几个一起回来：一行说几个，出错的另外标出来，逐个是谁在提示里", async () => {
	const view = await mount(
		h(DeliveryRow, {
			delivery: [
				{ id: "a", agent: "review", description: "审查前端", status: "done" },
				{ id: "b", agent: "explore", description: "找入口", status: "failed" },
				{ id: "c", agent: "plan", description: "规划", status: "done", incomplete: true },
			],
		}),
	);
	try {
		const row = view.find<HTMLButtonElement>("[data-delivery-row] button");
		assert.match(row.textContent ?? "", /消息来自 3 个子 Agent/);
		assert.match(row.textContent ?? "", /@review · @explore · @plan/);
		assert.match(row.textContent ?? "", /1 个出错/);
		const tip = row.getAttribute("data-ly-tip") ?? "";
		assert.match(tip, /审查前端（@review）— 完成/);
		assert.match(tip, /找入口（@explore）— 出错/);
		assert.match(tip, /规划（@plan）— 没做完/);
	} finally {
		await view.unmount();
	}
});

test("建议的会话交回：一行「来自新会话 · 标题」，不画子智能体的脸；点了去那个会话，没跑完的标出来", async () => {
	const previewed: string[] = [];
	const real = useApp.getState().previewSession;
	useApp.setState({
		activeSessionId: "s",
		sessions: [{ id: "s-child", title: "补上使用说明" } as never],
		previewSession: ((meta: { id: string }) => { previewed.push(meta.id); return 0; }) as never,
	});
	const view = await mount(h(DeliveryRow, { delivery: [{ id: "s-child", kind: "session", agent: "", description: "补上使用说明", status: "failed" }] }));
	try {
		assert.equal(view.find("[data-delivery-row]").getAttribute("data-delivery-kind"), "session");
		const row = view.find<HTMLButtonElement>("[data-delivery-row] button");
		assert.match(row.textContent ?? "", /来自新会话/);
		assert.match(row.textContent ?? "", /补上使用说明/);
		assert.match(row.textContent ?? "", /没跑完/);
		assert.equal(view.all("[data-delivery-row] .ly-avatar").length, 0, "不是子智能体");
		await act(async () => {
			row.click();
		});
		assert.deepEqual(previewed, ["s-child"]);
	} finally {
		await view.unmount();
		useApp.setState({ sessions: [], previewSession: real });
	}
});

test("子智能体要授权：卡上是它的脸和一行「谁在请求」；主智能体自己要的照旧是那枚图标", async () => {
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({
		activeSessionId: "s",
		approvals: [{ id: "r1", kind: "write", title: "写入 src/a.ts", detail: "src/a.ts", subject: "src/a.ts", from: { subAgentId: "s:sub:1", agent: "general", description: "改登录流程" } }],
	});
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	try {
		assert.match(view.find("[data-approval-from]").textContent ?? "", /子 Agent「改登录流程」在请求 · @general/);
		assert.equal(view.all("[data-approval-card] .ly-avatar").length, 1);

		await act(async () => {
			useApp.setState({ approvals: [{ id: "r2", kind: "bash", title: "跑命令", detail: "ls", subject: "ls" }] });
		});
		assert.equal(view.all("[data-approval-from]").length, 0);
		assert.equal(view.all("[data-approval-card] .ly-avatar").length, 0);
	} finally {
		await view.unmount();
		useApp.setState({ approvals: [] });
	}
});
