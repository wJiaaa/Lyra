/**
 * 主会话派出去的子代理：派出即放手，跑完一个送回一个。
 *
 * `task` 当场交回一句「已经派出去了」，这一轮接着走——手上还有不依赖它的事就做，没有就把这一轮
 * 收掉。子代理在后台跑完，结果由运行时作为一条消息送回主会话（`SessionDeliveries`：忙着就插进
 * 这一轮，闲着就开一个新回合），主智能体就这一份说清它带来了什么、还在等谁；全部回来之后再合并。
 *
 * 从前是反过来的：`task` 同步等到子代理交差，只有人插话时才放手（理由是「平时的路一步都不多」）。
 * 换掉它是一次明确的取舍——人要的是每回来一路就看到一路的结论、等的时候能直接跟主智能体说话，
 * 代价是每次送达多一轮请求、多读一遍前缀。攒送达的那 400ms 会把前后脚回来的几份合成一轮。
 * 取舍见 docs/adr/0051-sub-agents-report-one-by-one.md。
 *
 * 「这个会话闲了没有」因此要把还在后台跑的算进去（`outstanding`，见 `AgentSession.idle`）：
 * 派完那一轮收尾时，活其实刚开始。
 *
 * 只管主会话派出去的那一层：子代理手里没有 `task`（见 `dispatch-guard.ts`）。
 */

import type { DeliveredReport, Message, SubAgentAnswer } from "../../types.ts";
import type { SubAgentSummary } from "../../types/sub-agent.ts";

/** 一个放了手的派发跑完了。 */
export interface SettledDispatch {
	id: string;
	answer?: SubAgentAnswer;
	/** 跑到一半抛了——`task` 本来会把它变成一次工具错误，现在只能随结果一起送回去。 */
	error?: string;
}

export interface DelegationWaitHooks {
	/** 人说的话已经排着、还没被读到：这时开始的等待（`until`）当场放手。 */
	spoken(): boolean;
	/** 放手了：登记簿上标一下它在后台。 */
	detached(id: string): void;
	/** 放了手的那个跑完了：把结果送回主会话。 */
	settled(report: SettledDispatch): void;
}

export class DelegationWaits {
	/** 父会话正等着的事（`until`），每个对应一个「放手」的办法。 */
	private readonly held = new Set<() => void>();
	/** 放了手、还在后台跑的，按登记 id。跑完了要送回去的就是这些。 */
	private readonly detached = new Set<string>();
	private readonly hooks: DelegationWaitHooks;

	constructor(hooks: DelegationWaitHooks) {
		this.hooks = hooks;
	}

	/** 还在后台跑、跑完要送回来的有几个。 */
	get outstanding(): number {
		return this.detached.size;
	}

	/**
	 * 派出去，当场放手：交回一句「已派出」，结果跑完后经 `settled` 送回。
	 *
	 * `runSubAgent` 在第一个 await 之前就登记了，所以这时 `id()` 已经有了。没有的，是还没上名单
	 * 就被拒了（不认识的类型、续跑不了的 id）——那就照旧等它，拒绝的理由当场作为工具错误交回，
	 * 而不是晚一轮才送到。
	 */
	dispatch(run: Promise<SubAgentAnswer>, id: () => string | undefined): Promise<SubAgentAnswer> {
		const dispatched = id();
		if (!dispatched) return run;
		this.detached.add(dispatched);
		this.hooks.detached(dispatched);
		const settle = (report: Omit<SettledDispatch, "id">) => {
			// 放手之后会话被停过（`forget`）或派发被撤回了（`forgetUnless`），就不再送。
			if (this.detached.delete(dispatched)) this.hooks.settled({ id: dispatched, ...report });
		};
		run.then(
			(answer) => settle({ answer }),
			(error: unknown) => settle({ error: error instanceof Error ? error.message : String(error) }),
		);
		return Promise.resolve(dispatchedAnswer(dispatched));
	}

	/**
	 * 等一件不是派发的事（宿主的工具在等另一个会话做完），同样人一开口就放手：交回 `null`。
	 *
	 * 和 `dispatch` 的差别是放手之后没有东西要送回来——那件事不归这个会话管，要不要再等由模型决定。
	 */
	until<T>(run: Promise<T>): Promise<T | null> {
		return new Promise<T | null>((resolve, reject) => {
			const release = () => {
				if (this.held.delete(release)) resolve(null);
			};
			this.held.add(release);
			run.then(
				(value) => {
					if (this.held.delete(release)) resolve(value);
				},
				(error: unknown) => {
					if (this.held.delete(release)) reject(error);
				},
			);
			if (this.hooks.spoken()) release();
		});
	}

	/** 人开口了：正在等的全部放手。返回放了几个。 */
	release(): number {
		const all = [...this.held];
		for (const release of all) release();
		return all.length;
	}

	/** 会话停下了：已经放手的那些不再送回来。它们自己由登记簿停下。 */
	forget(): void {
		this.detached.clear();
	}

	/** 历史被截回去了：派发那一步已经不在历史里的，不再送回来。返回这些 id，它们由登记簿停下。 */
	forgetUnless(kept: (id: string) => boolean): string[] {
		const cut = [...this.detached].filter((id) => !kept(id));
		for (const id of cut) this.detached.delete(id);
		return cut;
	}
}

/**
 * 派出去时交给父会话的那句话。
 *
 * 写给模型的，所以三件事都要说到：它在后台跑（不是失败，也不是结论）；结果会自己回来——不用等、
 * 不用查、不用 `resume`，更不要重派或自己把它的活做一遍；这一轮接下来该怎么收。最要紧的是第二条：
 * 模型只知道「这个任务还没拿到结果」时，最顺手的一步是再派一个、或者自己去读同一批文件。
 */
function dispatchedAnswer(id: string): SubAgentAnswer {
	return {
		text:
			"（已派出，在后台跑。它跑完后，结果会作为一条消息自动送到你这里——不用等它、不用查它的进度、不用 resume，" +
			"也不要重派或自己去做它正在做的事。手上还有不依赖它结果的事就接着做；没有的话，用一两句话告诉用户派出去做什么，结束这一轮。）",
		id,
		detached: true,
	};
}

/**
 * 一个自己结束了的后台命令（`bash` 的 `run_in_background`，或超时转到后台的那些）。
 *
 * 和子代理的结果走同一条送达：模型不用再拿 `bash_output` 一遍遍去问「好了没」，每问一次都是一整轮
 * 请求；这一轮已经说完的时候，它跑完了也有人把会话叫醒。`status` 和 `output` 是替模型做的那一次
 * 读取（见 `readJob`），所以之后再读不会重发同一段。
 */
export interface FinishedJob {
	id: string;
	command: string;
	description?: string;
	exitCode: number | null;
	status: string;
	failed: boolean;
	output: string;
}

/**
 * 一个从建议卡片上开出来的会话跑完了第一轮，按它被要求的交回来（桌面端的 `spawn_session` 的 `reportBack`）。
 *
 * 它不是子代理：人看得见它、能在里面插话，跑完它还在。交回的是它最后那段回复，和子代理的结果走同一条
 * 送达，所以父会话闲着时一样被叫醒、忙着时一样插进这一轮。
 */
export interface FinishedSession {
	sessionId: string;
	title: string;
	status: "done" | "failed";
	reply: string;
}

/** 送达消息里一份报告需要的东西：跑完的结果，和登记簿上它是谁。 */
export interface DeliveryItem {
	report: SettledDispatch;
	/** 登记簿里的那一条；被挤出名单的（极少）没有，就只剩结果本身。 */
	summary: Pick<SubAgentSummary, "agent" | "description" | "status" | "incomplete"> | null;
}

/**
 * 后台子代理的结果，作为一条消息回到主会话。
 *
 * 给模型读的那一份是结果原文，外面套一层标签说清是谁、干的什么、怎么收场的。末尾那句话分两种：
 *
 * - 还有没回来的（`pending`）：只就这几份说清带来了什么、还在等谁，不写最终回答。点名还在等的是
 *   谁，模型才不会把「第一份到了」当成「都到了」去收尾，也不会自己动手去补还没回来的那一份。
 * - 都回来了：这是材料，不是成品——合并成一份按问题组织的回答。几份一起到时，模型最顺手的写法是
 *   按人头逐个转述（「子智能体 2 做了什么」），那是把它自己该做的合并推给了读的人。
 *
 * `delivery` 给界面：画成一行「谁的结果到了」，不是一个人发的气泡。
 */
export function deliveryMessage(items: DeliveryItem[], jobs: FinishedJob[] = [], pending: Pick<SubAgentSummary, "agent" | "description">[] = [], sessions: FinishedSession[] = []): Message {
	const blocks = items.map(({ report, summary }) => {
		const status = report.error ? "failed" : (summary?.status ?? "done");
		const body = report.error ? `它没能跑完：${report.error}` : report.answer?.text || "（它跑完了，但什么都没交回来。）";
		const attrs = [
			`id="${report.id}"`,
			summary ? `agent="${attribute(summary.agent)}"` : "",
			summary ? `task="${attribute(summary.description)}"` : "",
			`status="${status}"`,
		].filter(Boolean);
		return `<subagent_result ${attrs.join(" ")}>\n${body}\n</subagent_result>`;
	});
	const delivery: DeliveredReport[] = items.map(({ report, summary }) => ({
		id: report.id,
		agent: summary?.agent ?? "",
		description: summary?.description ?? "",
		status: report.error ? "failed" : summary?.status === "failed" || summary?.status === "aborted" ? summary.status : "done",
		...(report.answer?.incomplete || summary?.incomplete ? { incomplete: true } : {}),
	}));
	const jobReports: DeliveredReport[] = jobs.map((job) => ({
		id: job.id,
		kind: "job",
		agent: "",
		description: job.description || job.command,
		command: job.command,
		exitCode: job.exitCode,
		status: job.failed ? "failed" : "done",
	}));
	const agentParts =
		items.length === 0
			? []
			: [
					"（运行时送达）你之前派出去的子代理有结果了：",
					...blocks,
					pending.length > 0
						? `还有 ${pending.length} 个没回来：${pending.map((one) => `${one.agent}（${one.description}）`).join("、")}。它们跑完也会这样送到。` +
							"现在只就上面这几份用一两句话告诉用户：带来了什么结论、还在等哪几个——不要写最终回答，也不要自己去做它们正在做的事。"
						: "派出去的都回来了。这些是交给你的材料，不是给用户的成品：结合之前送到的和用户后来说的话接着做。需要回答用户时，把结论合并成一份按问题组织的回答——去重、核对关键结论，不要逐个转述「某个子代理做了什么」。",
				];
	const jobParts =
		jobs.length === 0
			? []
			: [
					"（运行时送达）你之前放到后台的命令结束了。下面是它的退出状态和你上次读取之后的输出，不用再拿 bash_output 去查：",
					...jobs.map((job) => `<background_job id="${job.id}" command="${attribute(job.command)}" status="${attribute(job.status)}">\n${job.output}\n</background_job>`),
				];
	const sessionReports: DeliveredReport[] = sessions.map((one) => ({ id: one.sessionId, kind: "session", agent: "", description: one.title, status: one.status }));
	const sessionParts =
		sessions.length === 0
			? []
			: [
					"（运行时送达）你之前建议另开、用户点了开始的会话跑完了第一轮。下面是它最后的回复；那个会话还在，用户可以接着在那里跟它说话：",
					...sessions.map((one) => `<session_result id="${one.sessionId}" title="${attribute(one.title)}" status="${one.status}">\n${one.reply || "（它没有留下回复。）"}\n</session_result>`),
					"就着这份结果接着做你手上的事：说清它带来了什么、要不要因此改你正在做的。它做过的事不要再做一遍。",
				];
	return {
		role: "user",
		synthetic: true,
		timestamp: Date.now(),
		delivery: [...delivery, ...jobReports, ...sessionReports],
		/*
		 * 一份报告一个文本块：发送前和 `task` 当场交回的结果按同一条线剪（见 `pruneMessage`），分块时
		 * 只剪超长的那份，几份一起到的时候不会把夹在中间的整份剪掉。
		 */
		content: [...agentParts, ...jobParts, ...sessionParts].map((text) => ({ type: "text" as const, text })),
	};
}

/** 标签属性里的值：引号换掉，换行压平，免得一句描述把标签撑破。 */
function attribute(value: string): string {
	return value.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}
