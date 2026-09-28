/**
 * Three limits on delegation, none of which is optional.
 *
 * Sub-agents are the one feature where a bad prompt costs real money rather than a wasted turn:
 * an agent that dispatches twelve at once, or one that dispatches something which dispatches it
 * back, spends without any of the usual signals that something has gone wrong. All three failures
 * look like the system working hard.
 *
 * The limits are enforced in different places on purpose:
 *
 *   Concurrency is a queue rather than a refusal. Wanting to look at eight things is a reasonable
 *   thought; running eight at once is what is unreasonable, and the correct answer to "do these
 *   eight" is to do them, four at a time.
 *
 *   Depth removes the `task` tool from the run instead of refusing calls to it. A model cannot
 *   want a tool it was never shown, and an error after the fact costs a turn to discover something
 *   that was never going to work.
 *
 *   Self-recursion is a refusal, because it is always a mistake. `explore → reviewer → explore` is
 *   a prompt written wrong, and it burns money fast enough that failing loudly is the kindness.
 */

/** How many sub-agents may run at once. Beyond this they queue. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Hard ceiling on how many sub-agents may run at once.
 *
 * Eight is already a lot: each one is a full model run with its own context. Sixteen used to be
 * the stored cap, and a setting that means "how many at once" should not become a number nobody
 * would pick on purpose. The gate and the settings file both read this same constant.
 */
export const MAX_CONCURRENT_SUB_AGENTS = 8;

/**
 * What the settings file is allowed to mean by `maxConcurrentSubAgents`.
 *
 * Anything below 1 is not a concurrency, so it falls back to the default rather than being stored
 * as 0 or a negative. Anything above the ceiling is cut down to it, including a 16 that an older
 * build would have accepted.
 */
export function normalizeMaxConcurrentSubAgents(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.min(MAX_CONCURRENT_SUB_AGENTS, Math.floor(value))
		: DEFAULT_MAX_CONCURRENT;
}
/** How deep dispatch may nest. The main conversation is 0. */
export const DEFAULT_MAX_DEPTH = 2;

export const DISPATCH_KEY = "dispatchChain";

/** Where this run sits in the tree, carried down through each dispatch. */
export interface DispatchContext {
	/** 0 for the main conversation. */
	depth: number;
	/** Agent names from the root down to and including this run. */
	chain: string[];
	/**
	 * The registry id of the run this context belongs to; the main conversation has none.
	 *
	 * `chain` says what kind of agent dispatched this one; this says which. Two `explore` runs
	 * fanned out by the same orchestrator have the same chain, and the lineage the pane draws
	 * needs to tell them apart.
	 */
	id?: string;
}

export function rootDispatch(): DispatchContext {
	return { depth: 0, chain: [] };
}

export function childDispatch(parent: DispatchContext, agent: string, id?: string): DispatchContext {
	return { depth: parent.depth + 1, chain: [...parent.chain, agent], ...(id ? { id } : {}) };
}

/**
 * Why a dispatch cannot proceed, or undefined when it can.
 *
 * Returns the sentence the model will read. It names the limit and what to do instead, because
 * "refused" without either is a message a model can only respond to by trying again.
 */
export function refuseDispatch(
	context: DispatchContext,
	agent: string,
	limits: { maxDepth?: number } = {},
): string | undefined {
	const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;

	if (context.depth >= maxDepth) {
		return `派生已经到了第 ${context.depth} 层，上限是 ${maxDepth}。这一层的活自己做完，不要再往下派。`;
	}

	if (context.chain.includes(agent)) {
		return (
			`\`${agent}\` 已经在这条派生链上（${[...context.chain, agent].join(" → ")}），不能再派它一次。` +
			`这种环通常是提示词写歪了——把要做的事直接说清楚，或者换一个 agent。`
		);
	}

	return undefined;
}

/**
 * A semaphore that queues rather than rejects.
 *
 * Held per session: two windows working on two projects should not slow each other down, and a
 * process-wide limit would do exactly that while looking like the app being slow.
 */
export class DispatchGate {
	private limit: number;
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(limit: number = DEFAULT_MAX_CONCURRENT) {
		this.limit = Math.max(1, limit);
	}

	get running(): number {
		return this.active;
	}

	get queued(): number {
		return this.waiting.length;
	}

	get width(): number {
		return this.limit;
	}

	/**
	 * 改宽度，因为这个数字会在会话中途变。
	 *
	 * 闸门是会话级的（见 `turn-config.ts` 里的 `dispatchGate`），而决定它多宽的 `maxConcurrentSubAgents`
	 * 可能在对话进行到一半时被改掉——如果闸门还是开会话那一刻的宽度，那次调整就只改了提示词里的
	 * 一句话，没改它管的那件事。
	 *
	 * 收窄不打断已经在跑的：一个跑到一半的子代理被腰斩，换来的只是一份半截的工作和一次白花的
	 * 调用。新的宽度从下一个想进来的开始生效，这也是排队本来的语义。放宽要主动放人进来，否则
	 * 队列里的那些要一直等到有人跑完才动——而刚刚发生的事情是「位置变多了」，不是「有人走了」。
	 */
	setLimit(limit: number): void {
		const next = Math.max(1, Math.floor(limit));
		if (next === this.limit) return;
		this.limit = next;
		// 放宽要主动放人：刚刚发生的事情是「位置变多了」，而队列只认「有人走了」。
		this.admit();
	}

	/**
	 * Run `body` when a slot is free. The slot is always released, including on a throw.
	 *
	 * `signal` 是派它的那一方的停止信号。排队中被停：出队、不占名额、`body` 不跑；放行之后、
	 * 开跑之前被停：同样不跑，名额当场还回去。以前排队不看信号，停止只停得到已经登记在册的
	 * 那几个，排在后面的照样一个个被放进来跑完——用户按了停，钱还在花。
	 */
	async run<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.acquire(signal);
		try {
			// 放行和醒来之间隔着一个微任务，停止可能正好落在这里：名额已经记上了，交给 finally 还。
			if (signal?.aborted) throw cancelled(signal);
			return await body();
		} finally {
			release();
		}
	}

	/**
	 * 拿一个名额，还回去的办法作为返回值交出来。
	 *
	 * 和 `run` 是同一件事的两种写法。`run` 把「拿、干、还」包成一个调用，适合身体就是一个函数的
	 * 场合；子代理不是——它要先登记、说出自己排在队里，**然后**才等名额，而登记和干活中间隔着的正是
	 * 这一次等待。把它的一整段身体塞进一个闭包，只为了在中间插一个 `await`，读的人要跳过五百行
	 * 缩进才看得到那一行。
	 *
	 * `signal` 管的是排队这一段：排着的时候被叫停，它当场离队，不再占着一个会在以后某一刻被放进来
	 * 的位置；已经停了的信号连空着的名额也不拿。
	 */
	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw cancelled(signal);
		if (this.active < this.limit) {
			this.active += 1;
		} else {
			/*
			 * 名额由放行的一方记账，见 `admit`。
			 *
			 * 这里曾经是等到之后自己 `active += 1`，也就是在 `await` 之后、一个微任务之后。只有
			 * 一个放行点的时候那样没问题；`setLimit` 一次放三个人，就不行了——三个人的记账都排在
			 * 循环之后，循环里读到的 `active` 三次都是同一个老数字。
			 */
			await this.wait(signal);
		}
		let released = false;
		return () => {
			// 还两次是一个 bug，但不该让闸门从此多出一个谁也拿不走的空位。
			if (released) return;
			released = true;
			this.active -= 1;
			this.admit();
		};
	}

	/** 排队，直到 `admit` 叫到自己；被叫停就离队。 */
	private wait(signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const turn = () => {
				signal?.removeEventListener("abort", leave);
				resolve();
			};
			const leave = () => {
				const at = this.waiting.indexOf(turn);
				// 已经被叫到（`admit` 把它取走了）的不算离队：名额记在它头上，由它自己还。
				if (at < 0) return;
				this.waiting.splice(at, 1);
				reject(cancelled(signal));
			};
			this.waiting.push(turn);
			signal?.addEventListener("abort", leave, { once: true });
		});
	}

	/**
	 * 派生里的派生：先把自己的位置让出来，再让孩子按正常规则进。一个父代理调一次，它派的孩子都走这里。
	 *
	 * 整棵派生树共用一道闸门（这是对的——不然「最多四个」会变成每层四个）。但一个正在派孩子的
	 * 子代理，这一刻并没有在跑模型，它在等。占着位置等，而等的正是同一道闸门里的位置，那就是
	 * 一个死锁：闸门开到 1 的时候，第二层永远进不来，整棵树停在那里，界面上是一个「派发子任务」
	 * 转到超时。
	 *
	 * 四个子代理各派一个孙代理、`limit` 是 4，同样谁也进不去；宽度设成 1 时则是必然。
	 *
	 * 让位属于父亲，不属于每个孩子：第一个孩子进来时让一次，最后一个孩子走了才取回。按孩子让的话，
	 * 父亲一次并行派四个就让了四次，宽度 1 时四个孩子同时在跑，计数却一直是 1。
	 *
	 * 让出的位置不主动放给队列，是留给孩子的：它下一行就要进来，而这个位置本来就是它父亲的。
	 * 取回的时候不排队，无条件加回去——排队等的可能正是自己刚让出去的那个位置，而那个位置上的人
	 * 在等自己。宁可有那么一瞬多出一个，也不要一个永远解不开的环。
	 */
	children(): { acquire(signal?: AbortSignal): Promise<() => void>; run<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> } {
		let present = 0;
		let yielded = false;
		// 正常走的孩子：它的名额转给父亲（调用方随后 `release` 抵掉）。
		const leave = () => {
			present -= 1;
			if (present === 0 && yielded) {
				yielded = false;
				this.active += 1;
			}
		};
		/*
		 * 没排上就被叫停的孩子：没有名额可转。父亲有空位就拿，没有就排在队首等下一个空出来的——无条件加回去
		 * 会让宽度 1 时父亲和刚被放进来的别人同时在跑。这时父亲已经没有在跑的孩子，占着名额的都不在等它，
		 * 排队不会成环。等待不听停止信号：父亲之后一定会还自己的名额，没拿回来就还，计数会变成负的。
		 */
		const abandon = async () => {
			present -= 1;
			if (present !== 0 || !yielded) return;
			yielded = false;
			if (this.active < this.limit) this.active += 1;
			else await new Promise<void>((resolve) => this.waiting.unshift(resolve));
		};
		const acquire = async (signal?: AbortSignal): Promise<() => void> => {
			// 走到这里的一定是个已经拿到名额的子代理；0 只可能是没有会话的宿主临时开的一道新闸门。
			if (present === 0 && this.active > 0) {
				yielded = true;
				this.active -= 1;
			}
			present += 1;
			let release: () => void;
			try {
				release = await this.acquire(signal);
			} catch (error) {
				await abandon();
				throw error;
			}
			let returned = false;
			return () => {
				if (returned) return;
				returned = true;
				// 先让父亲取回名额，再还孩子的：反过来的话，还回去的那一个先被排队的人拿走，父亲再无条件加回来，就超了宽度。
				leave();
				release();
			};
		};
		return {
			acquire,
			async run(body, signal) {
				const release = await acquire(signal);
				try {
					return await body();
				} finally {
					release();
				}
			},
		};
	}

	/** 在宽度允许的范围内依次放行，名额在这里记账。 */
	private admit(): void {
		while (this.active < this.limit) {
			const next = this.waiting.shift();
			if (!next) return;
			this.active += 1;
			next();
		}
	}
}

/** 排队时被叫停。和 `AbortSignal` 的原因一起抛，调用方据此分辨「被停」和「出错」。 */
export class DispatchCancelled extends Error {
	readonly reason: unknown;

	constructor(reason: unknown) {
		super("dispatch cancelled while queued");
		this.name = "DispatchCancelled";
		this.reason = reason;
	}
}

function cancelled(signal?: AbortSignal): DispatchCancelled {
	return new DispatchCancelled(signal?.reason);
}

/**
 * The sentence in the prompt that tells the model the limit.
 *
 * Without it a model dispatches twelve and then wonders why the answers are so slow to arrive —
 * it has no way to know that eight of them are sitting in a queue, and the natural reading of
 * "this is slow" is to try harder.
 *
 * 但这句话从前说反了一半。它写的是「一次派超过 N 个只会让结果更晚到，不会更快」，模型读到的是
 * 「一次别派超过 N 个」——闸门开到 1 的时候，就成了「一轮只派一个」：派一个、等它跑完、再开一轮
 * 派下一个。2026-09-26 的真实会话里四个审查子代理就是这样排成一串的，每两个之间隔着一整轮主模型
 * 的请求，而那几分钟里主会话的缓存也凉了。
 *
 * 排队本来就是闸门替模型做的事：一次交齐，多出来的自己排着，前面的跑完一个就补上一个——这比
 * 模型自己一轮一个地喂，每一个都早到一整轮。所以现在说的是「一起派，排队不用你管」，数字只用来
 * 解释为什么有的回来得晚。
 */
export function concurrencyNote(limit: number, maxDepth: number): string {
	return (
		"互不依赖的几件事，在同一条回复里一起派出去（一次发出多个 `task` 调用）：" +
		`最多 ${limit} 个子代理同时跑，多出来的自动排队，前面的跑完一个就补上一个——排队不用你管，也不多花钱。` +
		"别为了等前一个的结果而一轮只派一个，那样每多派一个就多等一整轮。" +
		`派生最多嵌套 ${maxDepth} 层。`
	);
}
