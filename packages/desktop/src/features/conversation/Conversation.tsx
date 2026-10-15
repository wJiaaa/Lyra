import { ChevronDown, ChevronUp } from "../../ui/icons/index.ts";
import { translate } from "../../i18n/translate.ts";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { BackToLatest } from "./BackToLatest.tsx";
import { Composer } from "../composer/index.ts";
import { ResumeRow } from "./ResumeRow.tsx";
import { HiccupRow } from "./HiccupTrace.tsx";
import { ModelSwitchRow } from "./ModelSwitchRow.tsx";
import { RunningRow } from "./RunningRow.tsx";
import { TaskList } from "../task/index.ts";
import { environmentCard, useEnvironmentCard } from "../../store/environment-card.ts";
import { clearTranscriptJump, useTranscriptJump } from "../../store/transcript-jump.ts";
import { BrowserCards, laterPageOpens, pageOpens } from "./BrowserCard.tsx";
import { GeneratedImages } from "./ImageCanvas.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { useAnswering } from "./useAnswering.ts";
import { isNudge, runs, runKey, turnBlocks, withoutThinking, type Run } from "./grouping.ts";
import { intact } from "../../lib/transcript.ts";
import { LiveToolCard, ToolRun as ToolRunGroup, WINDOW_TURNS } from "./runs.tsx";
import { CommandRunRow } from "./CommandRunRow.tsx";
import { HookTrustBanner } from "./HookTrustBanner.tsx";
import { QuestionNav } from "./QuestionNav.tsx";
import { QuoteMenu } from "./QuoteMenu.tsx";
import { questionsIn, timeSeparators } from "./question-navigation.ts";
import { MessageRow, planMarkdown } from "./rows.tsx";
import { TurnWork } from "./TurnWork.tsx";
import { WorkStep, type DrawCall } from "./WorkStep.tsx";
import { useTranscriptWindow } from "./view-state.ts";
import { flash, settleReveal, useDrawingReveal } from "./reveal.ts";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { useFollowBottom } from "../../ui/scroll/useFollowBottom.ts";
import { tailSignature } from "../../ui/scroll/signature.ts";
import { useLayout } from "../../app/layout.tsx";
import { useApp } from "../../store/index.ts";
import {
	useScopedCommandRuns,
	useScopedCompactions,
	useScopedHiccups,
	useScopedLoading,
	useScopedMessages,
	useScopedRunning,
	useScopedSessionId,
	useScopedToolRuns,
} from "../../app/session-scope.tsx";

/**
 * Nothing about the window's shape belongs to the transcript.
 *
 * The transcript takes no props: everything it draws comes from the store, and the store tells it
 * directly when that changes. But it is mounted inside the dock, and the dock is re-rendered by
 * every drag — a pane's boundary, a pane being carried, the sidebar's edge — so a fresh element
 * was handed down forty-five times a second and React rebuilt several hundred rows behind it, each
 * one re-parsing its markdown. Dragging the sidebar across a long session cost 470KB of re-parsed
 * prose per gesture. A memo boundary here is one comparison of two empty objects, and it is where
 * the layout stops being the transcript's business.
 */
/**
 * The width below which the question rail stops getting a column of its own.
 *
 * Indenting the text 48px to clear the rail costs a tenth of a 520px column and nothing worth
 * noticing above it — and the right side is padded 16px whatever happens, so the whole difference
 * lands as the transcript sitting visibly right of centre. Below this the rail goes against the
 * edge and both sides get 28px.
 */
const NARROW_COLUMN = 520;
/*
 * 环境卡片那一条：卡片 300 宽，右边距 12，和正文之间再留 12。
 *
 * 栏够宽（让出这一条以后正文还有 `NARROW_COLUMN`）时正文和输入框整体往左让，卡片不盖住任何字；
 * 不够宽就像任务清单一样浮在正文上——这时让位会把正文挤成一条缝。
 */
const ENVIRONMENT_CARD = 300;
const ENVIRONMENT_LANE = ENVIRONMENT_CARD + 24;

/**
 * `side`：画的是一格侧边聊天（`SessionScope` 指向那个会话）。转录、工具卡、审批和主对话完全一样；
 * 主对话外围那几样——环境卡片、任务清单、「接着做」、问题导航、钩子提示、输入框——不画，输入框由
 * 侧边聊天自己摆在底下。
 */
export const Conversation = memo(function Conversation({ sessionId: _sessionId, side = false }: { sessionId?: string | null; side?: boolean } = {}) {
  /*
   * 转录的入口，也是那道闸门的位置。
   *
   * `intact` 放在这里而不是只放在 `runs` 里，是因为这一条数组要交给五个消费者——`runs`、
   * `timeSeparators`、`questionsIn`、`useAnswering`、`tailSignature`——它们各自都会去读 `role`。
   * 只挡住其中一个，另外四个照样能把整个窗口掀翻，而报出来还是同一句话。
   *
   * 没有损坏时 `intact` 交回的是同一个引用，所以下面那些 `useMemo` 的依赖不会因此失效。
   */
  const rawMessages = useScopedMessages();
  const messages = useMemo(() => intact(rawMessages), [rawMessages]);
  const running = useScopedRunning();
  const compactions = useScopedCompactions();
	const commandRuns = useScopedCommandRuns();
	/*
	 * 这一轮里连接抖过没有，以及最后怎么了。
	 *
	 * 和压缩标记、命令边界一起交给 `runs`，因为它们是同一种东西：转录里按位置插进去的一条记录。
	 * 从前它是转录末尾单独的一丛，一律挂在运行指示器底下——那让一句「重连 2 次后恢复」站在了「此刻」
	 * 的位置上，而它说的是四十分钟前的事。见 `HiccupTrace`。
	 */
	const hiccups = useScopedHiccups();
	const compacting = commandRuns.some((command) => command.status === "running");
  /*
   * How many tool calls there are, and how many have stopped running.
   *
   * Both halves matter and only the first used to be here. A call settling changes the card —
   * output replaces the spinner, a duration appears, an error opens — without touching a message
   * and without changing how many calls exist, so a signature built from the count alone was
   * identical either side of the one moment a tool card changes size the most.
   *
   * Still a count rather than the map: a streamed chunk moves neither number, which is what keeps
   * the layout effect off the per-token path. Growth inside a running card is left to the resize
   * observer, which is what it is for.
   *
   * Returned as a string so the selector compares by value; an object would be a new identity on
   * every store change and re-render the transcript for each one.
   */
  const toolRuns = useScopedToolRuns();
  const toolProgress = useMemo(() => {
    let total = 0;
    let settled = 0;
    for (const run of Object.values(toolRuns)) {
      total += 1;
      if (run.status !== "running") settled += 1;
    }
    return `${total}/${settled}`;
  }, [toolRuns]);
  const activeSessionId = useScopedSessionId();
  const loadingSession = useScopedLoading();
  // 推理默认不画，见 `withoutThinking`。
  const showThinking = useApp((s) => s.settings?.showThinking === true);
  const allRuns = useMemo(() => {
    const list = runs(messages, compactions, commandRuns, hiccups);
    return showThinking ? list : withoutThinking(list);
  }, [messages, compactions, commandRuns, hiccups, showThinking]);
  const separators = useMemo(() => timeSeparators(messages), [messages]);
  const questions = useMemo(() => questionsIn(messages), [messages]);
  /*
   * 先分块，再开窗——顺序反过来就是那个「点了没反应」的 bug。
   *
   * 窗口从前按 `Run` 走，而画出来的单位是 `TurnBlock`。一轮里可以有几百个 Run（一个会话在两次用户
   * 发言之间跑了 400 次工具调用），于是往那种轮次里翻页，60 个 Run 全落进一个已经收起的块，屏幕上
   * 只有「调用工具 N 个」那个数字在变。连点四次，转录一动不动。
   *
   * 按块开窗之后，翻一次必然多出整轮——必然看得见。一轮里同类的调用合成一行、每行默认收着（`WorkStep`
   * 收起时不渲染里面的调用），一轮四百次调用摊开也只是几十行。
   */
  const allBlocks = useMemo(
    // 跑着的那一轮从发出就按有过程分，见 `turnBlocks` 的 `live`。
    () => turnBlocks(allRuns, running),
    [allRuns, running],
  );
  const range = useTranscriptWindow(activeSessionId, WINDOW_TURNS, allBlocks.length);
  /*
   * 窗口挂上目标之后要滚到哪：问题导航点的那一问，或画廊要看的那张图。`lead` 是目标上方留的空，
   * 图放在正中间。
   */
  const [jump, setJump] = useState<{ sessionId: string | null; selector: string; block: number; lead: number | "middle"; flash?: boolean } | null>(null);
  const { compact } = useLayout();
  const gutter = compact ? "ly-content-gutter-compact" : "ly-content-gutter";
  /*
   * The floating card needs its own width plus a readable column left over beside it.
   * 320 for the card, 32 for the gap it keeps from the edge, and 420 of text — below that the
   * reply is a ribbon and the card should go and sit above the composer instead.
   */
  const column = useRef<HTMLDivElement>(null);
  const [roomToFloat, setRoomToFloat] = useState(false);
  const [roomToDock, setRoomToDock] = useState(false);
  const EnvironmentCard = environmentCard();
  const environmentOpen = useEnvironmentCard((state) => state.open) && !side && activeSessionId !== null && EnvironmentCard !== null;
  const docked = environmentOpen && roomToDock;
  /*
   * Too narrow to spend 48px on the question rail and leave the column looking centred.
   *
   * Asked of this column, not of the window. A 1400px window with the sidebar and a file panel
   * open leaves the transcript 460px wide, and 48 against 16 is just as lopsided there as it is on
   * a 380px window — the window is simply not what the reader is looking at. Below this the rail
   * moves to the very edge and the padding goes symmetric; see `QuestionNav`.
   */
  const [narrowColumn, setNarrowColumn] = useState(false);
  useEffect(() => {
    const element = column.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      setRoomToFloat(element.clientWidth >= 320 + 32 + 420);
      setRoomToDock(element.clientWidth >= ENVIRONMENT_LANE + NARROW_COLUMN);
      setNarrowColumn(element.clientWidth < NARROW_COLUMN);
    };
    const measure = () => {
      if (document.documentElement.hasAttribute("data-resizing")) {
        // Debounce / coalesce measurement during resizing drags so we don't trigger layout thrashing
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            read();
          });
        }
        return;
      }
      read();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  /**
   * The final answer is arriving right now.
   *
   * This is the moment the running indicator stops being informative and starts being noise — and
   * it lasts exactly as long as words are actually landing. Asked of the tail of the transcript and
   * of the clock, because the two ways it comes apart from "this reply has some text in it" are
   * both ordinary: a call appended after a sentence, and a stream that goes quiet. Both left the
   * line folded for the rest of a turn that was still running. See `conversation/answering.ts`.
   */
  const answering = useAnswering(messages);
  /** 最后一条是一段正常写完的回答：底下的操作行在这时长出来，运行行在同一帧让位，见 `RunningRow`。 */
  const answered = useMemo(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || last.stopReason !== "stop") return false;
    const block = last.content[last.content.length - 1];
    return block?.type === "text" && block.text.trim().length > 0;
  }, [messages]);

  /*
   * Following the bottom, and everything that decides whether to.
   *
   * All of it used to be here: a `pinnedToBottom` ref recomputed from `scrollTop` on every event, a
   * hand-rolled glide, a `missed` flag set from the fact that the messages array had been
   * reassigned. Three surfaces had their own copy of it and none of them agreed. See
   * `scroll/follow.ts` for the rule and `docs/2026-09-02-scroll-follow-design.md` for the four
   * reported bugs that came out of deriving the reader's intention from pixels the program also
   * writes.
   */
  const follow = useFollowBottom({
    surfaceId: activeSessionId,
    namespace: "transcript",
    ready: !loadingSession,
    live: running,
    count: messages.length + commandRuns.length,
    /*
     * What "something arrived" means here.
     *
     * `toolProgress` is folded in because a card appearing *or completing* changes the page without
     * touching a message — see its selector above for why both numbers are needed.
     */
    tail: tailSignature(messages, toolProgress),
  });
  const scrollRef = follow.scrollRef;

  /*
   * Sending puts you back at the bottom, wherever you had scrolled to.
   *
   * Reading back through a conversation and then asking something is ordinary, and the reply to
   * it arrives at the end — so staying where you were means watching a screen on which nothing
   * appears to happen. Your own message is the one thing you can be certain you want to see.
   */
  const pending = useApp((s) => {
    if (!activeSessionId || s.activeSessionId === activeSessionId) return s.pendingUserMessage;
    return s.sessionCache[activeSessionId]?.state?.pendingUserMessage ?? null;
  });
  const { returnToBottom } = follow;
  useLayoutEffect(() => {
    if (!pending && !compacting) return;
    range.latest();
    returnToBottom(true);
    // The pending object identifies one submission; changing the window is not a new submission.
    // oxlint-disable-next-line exhaustive-deps
  }, [pending, compacting, returnToBottom]);


  /*
   * Recomputed when the transcript changes, not on every render.
   *
   * A streaming reply re-renders this component on every token; without the memo each one walked
   * the whole message list again and handed every row a freshly built object, so React rebuilt
   * three hundred rows to show one more word arriving.
   */
  const hidden = range.start;
  /*
   * 分块只在转录变了的时候算一次。
   *
   * 它在渲染里被读两次（画每一块、判断哪一块是最后一块），直接调用就是每次渲染跑两遍分组，
   * 而这条转录在一轮里每个 token 都会重渲染。
   */
  const blocks = useMemo(() => allBlocks.slice(range.start, range.end), [allBlocks, range.start, range.end]);
  // 按整条转录算，不按窗口：同一轮后面那几块可能还没进窗口，卡片照样要知道自己不是最后一张。
  const laterPages = useMemo(() => laterPageOpens(allBlocks), [allBlocks]);
  const { scrollTo, detach } = follow;
  const jumpToQuestion = (index: number) => {
    // 窗口按块走，所以要的是「那条消息在哪个块里」，不是它在 Run 序列里的位置。
    const at = allBlocks.findIndex((block) => block.runs.some((run) => run.kind === "message" && run.index === index));
    if (at < 0) return;
    detach();
    range.reveal(at);
    setJump({ sessionId: activeSessionId, selector: `[data-question-index="${index}"]`, block: at, lead: 40 });
  };
  // 从转录以外要求跳到某一问（环境卡片里的「第 N 轮」）：照问题导航那条路走。
  const externalJump = useTranscriptJump((state) => state.jump);
  useEffect(() => {
    if (!externalJump || externalJump.sessionId !== activeSessionId) return;
    clearTranscriptJump();
    jumpToQuestion(externalJump.index);
    // `jumpToQuestion` is rebuilt every render; the request is what this reacts to.
    // oxlint-disable-next-line exhaustive-deps
  }, [externalJump, activeSessionId]);
  /*
   * 画廊要看的那张图。等这个对话读完才接：读完之前转录是空的，那时接下请求只能答一个「没有」。
   */
  const reveal = useDrawingReveal((state) => (state.sessionId && state.sessionId === activeSessionId ? state : null));
  useLayoutEffect(() => {
    if (!reveal || loadingSession) return;
    settleReveal(reveal.nonce);
    const at = allBlocks.findIndex((block) => block.runs.some((run) => run.kind === "tools" && run.calls.some(({ block: call }) => call.id === reveal.toolCallId)));
    if (at < 0) return;
    detach();
    range.reveal(at);
    setJump({ sessionId: activeSessionId, selector: `[data-ly-image-call="${CSS.escape(reveal.toolCallId)}"]`, block: at, lead: "middle", flash: true });
    // `range.reveal` is rebuilt every render; a new request or a finished read is what this answers.
    // oxlint-disable-next-line exhaustive-deps
  }, [reveal, loadingSession, allBlocks, activeSessionId, detach]);
  useLayoutEffect(() => {
    if (!jump || jump.sessionId !== activeSessionId) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(jump.selector);
    if (!target) {
      // 那一轮已经挂上了，目标还是没有——比如那次调用没留下图卡。没有可滚的，放下这次请求。
      if (jump.block >= range.start && jump.block < range.end) setJump(null);
      return;
    }
    const box = target.getBoundingClientRect();
    const lead = jump.lead === "middle" ? Math.max(40, (el.clientHeight - box.height) / 2) : jump.lead;
    const top = el.scrollTop + box.top - el.getBoundingClientRect().top - lead;
    /*
     * 目标挂着，可它下面挂着的东西不够把它顶上去：先把窗口往后放一截，下一次再滚。
     *
     * 窗口按轮计、一次二十轮，跳到窗口末尾那几轮时，`scrollTo` 会被夹在 scrollHeight − clientHeight
     * 上——问题停在屏幕半中间，而不是顶上 40px。`reveal` 对已经挂着的目标什么都不做，所以这里按
     * 真实像素补一句。放宽窗口的 setState 在 layout effect 里，绘制之前就重渲染完，第一帧不会动；
     * 窗口已经到底就照原样滚，那是真的没有更多可滚。
     */
    if (top > el.scrollHeight - el.clientHeight + 1 && range.end < allBlocks.length) {
      range.later();
      return;
    }
    scrollTo(top, true);
    if (jump.flash) flash(target, motionReduced());
    setJump(null);
    // `range.later` is rebuilt every render; the window's own edges are what this reacts to.
    // oxlint-disable-next-line exhaustive-deps
  }, [jump, activeSessionId, range.start, range.end, allBlocks.length, scrollRef, scrollTo]);

  return (
    <div ref={column} data-ly-chat-surface={side ? "side-chat" : "conversation"} className="relative flex min-h-0 flex-1 flex-col">
      {docked && EnvironmentCard && <EnvironmentLane card={EnvironmentCard} floatTasks={roomToFloat} />}
      {/*
       * The transcript and the button that scrolls it, in a box of their own.
       *
       * This used to be the same box as the composer, and `bottom` measured from the bottom of
       * *that* — so the button sat inside the field you type in rather than above the last
       * message. What it offers is about the transcript, so the transcript is what it is
       * positioned against.
       */}
      <div className="@container relative flex min-h-0 flex-1 flex-col" style={docked ? { marginRight: ENVIRONMENT_LANE } : undefined}>
      {environmentOpen && !docked && EnvironmentCard && <EnvironmentLane card={EnvironmentCard} floatTasks={roomToFloat} />}
      {/*
       * Over the transcript when there is room beside it, in the column when there is not.
       *
       * The plan is a companion to the conversation rather than part of it: it is one thing that
       * keeps changing, not another entry in a log, so it holds a fixed corner instead of
       * scrolling away with the messages that happened to be on screen when it was written. Below
       * the breakpoint there is no corner to spare — the transcript needs its full width — so it
       * moves to the one place that is always visible, just above where you type.
       */}
      {/*
       * Floating only when it can float clear of the words.
       *
       * The window being wide is not the same as this column being wide: open the side panel and
       * the transcript can be 600px inside a 1400px window, at which point a 320px card in the
       * corner is sitting on top of the reply rather than beside it. Measured here, against the
       * column it would cover.
       */}
      {roomToFloat && !environmentOpen && !side && (
        <div className="pointer-events-none absolute top-3 right-4 z-20 w-[320px]">
          <TaskList placement="floating" />
        </div>
      )}

      <Scroller
        className="flex-1"
        scrollRef={scrollRef}
        /*
         * The rail's room comes out of the column, so in a narrow column it comes out even.
         *
         * `pl-12 pr-4` clears the question rail on the left and leaves the right alone, which reads
         * as centred in a wide column and as visibly off-centre in a narrow one: 48 against 16 is a
         * twelfth of a 380px pane, and the whole transcript sits to the right of its own box. Below
         * `NARROW_COLUMN` the rail moves to the very edge and 28px each side clears it evenly.
         */
        contentClassName={questions.length > 1 && !side ? (narrowColumn ? "px-7" : "pl-12 pr-4 @min-[600px]:pr-8") : gutter}
        /*
         * 32px on top, the depth Claude's desktop transcript uses; the bottom's default 48 already
         * matches it.
         */
        fadeTop={32}
        onScroll={follow.onScroll}
        onResize={follow.onResize}
        onUserScroll={follow.onUserScroll}
        onHold={follow.hold}
        onSettle={follow.settle}
      >
        {/*
         * One tree per conversation. The pane keeps the last few mounted, so this
         * key only resets scroll when *this* session's id changes. No enter fade —
         * a 340ms opacity ramp after a click is the lag the list was already accused of.
         */}
        <div
          /* `--ly-bottom-inset` keeps 「回到最新」 off the newest message; see `styles/scroll.css`. */
          key={activeSessionId}
          className="ly-transcript ly-no-enter relative min-h-full mx-auto w-full max-w-[var(--ly-content)] pt-5 pb-[var(--ly-bottom-inset)]"
          data-ly-session={activeSessionId ?? ""}
          aria-busy={loadingSession}
        >
          {/*
           * Runs of tool calls are gathered across messages, not just inside one.
           *
           * A model that calls a tool, reads the result and calls the next one produces a fresh
           * assistant message every time. Grouping within a message therefore caught parallel
           * batches and missed sequential ones — which is the common case, and the one that
           * fills the transcript with a column of near-identical cards. A message carrying text
           * ends the run, because that is the model saying something worth reading.
           */}
          {/*
           * Only the tail is mounted until you ask for the rest.
           *
           * A day-long session runs to thousands of messages, each with its own cards and
           * expanders. Mounting all of them costs memory that never comes back and makes every
           * repaint walk the whole tree, which is what turns scrolling to treacle. The recent
           * end is what anyone is reading; the rest is one click away and stays unmounted until
           * then.
           */}
          {loadingSession && (
            <div
              role="status"
              className={
                allBlocks.length === 0
                  ? "absolute inset-0 flex items-center justify-center pointer-events-none"
                  : "flex items-center justify-center py-4"
              }
            >
              <ActionSpinner size={allBlocks.length === 0 ? 20 : 14} className="text-ink-faint" />
            </div>
          )}
          {hidden > 0 && (
            /*
             * 这颗按钮说的是整句话，不是一个数字。
             *
             * 它一度只画一个箭头和「60」，句子藏在 tooltip 里。一个数字不会自己解释自己——60 条
             * 什么？加载？未读？剩余？——而要读懂它得先把鼠标停上去等一秒，那是一次「先猜、再验」
             * 的交互，代价由每一个看到它的人付。键盘和读屏的人则连猜的机会都没有：`aria-label`
             * 是另一套说法，和眼睛看到的对不上。
             *
             * 一整行的宽度本来就摆在那儿，写完这句话绰绰有余。
             */
            <div className="mb-4 flex items-center justify-center">
              <button
                type="button"
                data-ly-show-earlier
                onClick={range.earlier}
                className="group/earlier inline-flex h-7 items-center gap-1.5 rounded-full border border-line-soft bg-card/40 px-3.5 text-detail text-ink-faint shadow-xs transition-colors duration-[var(--ly-t-quick)] hover:border-line hover:bg-card hover:text-ink-muted active:scale-[0.98]"
              >
                <ChevronUp size={12} strokeWidth={2} aria-hidden className="transition-transform duration-[var(--ly-t-quick)] group-hover/earlier:-translate-y-0.5" />
                {/*
                 * 「共 N 条」只在它确实是另一个数字时才出现。
                 *
                 * 最后一页里 n 和 total 是同一个数，「显示更早的 60 条（共 60 条）」把同一件事说了
                 * 两遍——而读到括号的人会以为里面有新消息。
                 */}
                <span className="tabular-nums">
                  {hidden > WINDOW_TURNS
                    ? translate("conversation.showEarlier", { n: WINDOW_TURNS, total: hidden })
                    : translate("conversation.showEarlierRest", { n: hidden })}
                </span>
              </button>
            </div>
          )}

          {/*
           * 按回合分块，不是逐条铺开。
           *
           * 一轮读下来是「想 → 做 → 说」。前两步是过程——跑的时候你在看着它，跑完之后它挡在答案
           * 前面就只是噪音。`turnBlocks` 在 Run 那一层把这件事定下来（规则性的东西要能单独测），
           * 这里只负责把有过程的一轮交给 `TurnWork` 一行行摊开。
           */}
          <div className="flex flex-col gap-2.5" data-ly-transcript-rows>
          {blocks.map((block, at) => {
            const draw = (run: Run) =>
            /*
						 * Automatic compaction belongs on the running indicator. An explicitly submitted
						 * command keeps its own result, so the user can verify the action they requested.
             */
            run.kind === "compaction" ? null : run.kind === "command" ? <CommandRunRow key={`${activeSessionId}:${runKey(run)}`} command={run.command} /> : run.kind === "hiccup" ? (
              <HiccupRow key={`${activeSessionId}:${runKey(run)}`} hiccup={run.hiccup} />
            ) : run.kind === "model" ? (
              <ModelSwitchRow key={`${activeSessionId}:${runKey(run)}`} from={run.from} to={run.to} />
            ) : run.kind === "message" ? (
              <MessageRow
                key={`${activeSessionId}:${runKey(run)}`}
                viewKey={runKey(run)}
                showTime={separators.has(run.index)}
                message={run.message}
                index={run.index}
                upTo={run.upTo}
                from={run.from}
                lead={run.lead}
                /* A turn the runtime carried straight on from did not end where it stopped. */
                continued={isNudge(messages[run.index + 1])}
                /* Computed with the grouping, so its identity changes only when the transcript
                 * does — see `Run` in `grouping.ts` for what recomputing it here used to cost. */
                turnStats={run.turnStats}
              />
            ) : (
              /* Keyed on the first call, not the position: inserting anything above must not
               * make React tear this run down and build it again. */
              <ToolRunGroup
                key={`${activeSessionId}:${runKey(run)}`}
                calls={run.calls}
                shown={run.shown}
                /*
                 * The run being worked on keeps its highlight moving — and only that one, so the
                 * transcript never claims two things are happening at once.
                 *
                 * Which run that is comes from `grouping.ts`, because it is a question about the
                 * shape of the turn rather than about the position of a row. Asking it here, as
                 * "the last run on screen", is what left a finished run gliding through the whole
                 * of the next reply: a new question does not move the last run, so the highlight
                 * simply stayed where the previous turn had left it.
                 *
                 * `running` is still asked separately: the newest work in a turn that has ended is
                 * still the newest work, and nothing should glide once the turn is over.
                 */
                live={running && Boolean(run.live)}
                // The turn line above says what the work amounted to; here every call is its own row.
                flat
              />
            );
            if (block.kind === "plain") return draw(block.runs[0]);
            const drawCall: DrawCall = ({ block: call, stopReason, page }, line) => <LiveToolCard block={call} stopReason={stopReason} page={page} thinking={line?.thinking} extra={line?.extra} />;
            /*
             * 不再有 `as Exclude<Run, { kind: "compaction" }>`。
             *
             * 那个断言是这次崩溃的来路：它把编译器的警告手动关掉了，而编译器警告的正是「这里可能
             * 是一个压缩标记」——一旦真是，`runKey` 会去读它没有的 `message`，整页白掉。`runKey`
             * 现在认得每一种 Run，断言也就没有存在的理由了。
             */
            /*
             * 按开这一轮的那句话起名，不按锚下面第一行：跑着的那一轮刚发出时下面是空的，第一行等它开口
             * 才有（见 `turnBlocks` 的 `live`）。按第一行起名，开口那一下整块就卸掉重建。没有开口那句的
             * （会话的第 0 轮）才退回第一行。
             */
            const opener = allBlocks[range.start + at - 1];
            const key = `${activeSessionId}:process:${runKey((opener?.turn === block.turn ? opener : block).runs[0])}`;
            /*
             * 这一轮里 agent 打开过的网页，画在锚下面那一列的最后。
             *
             * 有人把这一轮收起来时，卡片要是长在过程里就跟着收走了——而它是 agent 在后台开了网页这件事
             * 在对话里仅有的痕迹（面板不再自己弹出来，见 `BrowserCard`）。
             */
            const pages = pageOpens(block);
            // 这一轮里生成的图，同样画在外面，见 `GeneratedImages`。
            const drawn = block.runs.flatMap((run) => (run.kind === "tools" ? run.calls.filter(({ block: call }) => call.name === "image_generate").map(({ block: call }) => call.id) : []));
            /*
             * 按**回合**算，不是按块的位置算：正文一开始流式输出，过程就不再排在末尾。
             */
            const live = running && block.turn === blocks[blocks.length - 1].turn;
            const tail = block.items[block.items.length - 1];
            return (
              <Fragment key={key}>
                <TurnWork
                  entries={block.items.map((item) => ({
                    key: `${activeSessionId}:${item.key}`,
                    // 正在做的那一段是这一轮的最后一行：后面有了别的（下一段活、一句话），它就做完了。
                    node: item.kind === "step" ? <WorkStep step={item.step} live={live && item === tail} draw={draw} drawCall={drawCall} /> : draw(item.run),
                  }))}
                />
                {pages.length > 0 && <BrowserCards calls={pages} later={laterPages[range.start + at]} />}
                {drawn.length > 0 && <GeneratedImages calls={drawn} />}
              </Fragment>
            );
          })}
          </div>

          {/*
           * Present for the whole turn, and out of sight while the answer is arriving — at that point
           * it has been overtaken by what it was standing in for.
           *
           * It stays put through the parts of a turn: it used to appear only when the last message
           * had settled, so it came and went with every tool call, and its 46px came and went with
           * it, shifting the transcript up and down all through a turn.
           *
           * But once prose is streaming in above it, "Nearly there…" is describing something the
           * reader can already see the end of. Sitting under a finished answer saying almost-done
           * reads as the app having lost track of itself.
           *
           * Hidden rather than folded, so the height does not change at all — which is the whole
           * reason it was made to stay put in the first place. See `RunningRow`.
           */}
          {range.end < allBlocks.length && (
            <div className="my-3 flex items-center justify-center">
              <button
                type="button"
                data-ly-tip={translate("conversation.showLaterN", { n: Math.min(WINDOW_TURNS, allBlocks.length - range.end) })}
                aria-label={translate("conversation.showLaterN", { n: Math.min(WINDOW_TURNS, allBlocks.length - range.end) })}
                onClick={range.later}
                className="group/later inline-flex h-7 items-center gap-1.5 rounded-full border border-line-soft bg-card/40 px-3.5 text-detail text-ink-faint shadow-xs transition-colors duration-[var(--ly-t-quick)] hover:border-line hover:bg-card hover:text-ink-muted active:scale-[0.98]"
              >
                <ChevronDown size={12} strokeWidth={2} aria-hidden className="transition-transform duration-[var(--ly-t-quick)] group-hover/later:translate-y-0.5" />
                <span className="tabular-nums">{Math.min(WINDOW_TURNS, allBlocks.length - range.end)}</span>
              </button>
            </div>
          )}
          {range.end === allBlocks.length && <>
          {/* 回答在来的时候这一行只是看不见、高度不变，答完时当帧让位给操作行——为什么这样，见 `RunningRow`。 */}
          <RunningRow running={running} answering={answering} answered={answered} compacting={compacting} />
          {/* Where the running indicator would have been, saying why it is not there. */}
          {!side && <ResumeRow />}
          {/*
           * The end of the transcript, as an element.
           *
           * Marking the newest message read is the one question that cannot be answered by
           * arithmetic: someone who scrolls up two screens, reads the paragraphs that arrived and
           * stops there has caught up, and no distance-from-bottom test tells that apart from
           * someone who has not. This entering the viewport is the fact itself. Zero height, so it
           * changes nothing about the layout it reports on.
           */}
          <div ref={follow.tailRef} aria-hidden className="h-px w-full shrink-0" />
          </>}
        </div>
      </Scroller>

      {/*
       * Over the transcript's last few pixels, not in the flow.
       *
       * A button that took a row of its own would push the transcript up by its own height the
       * moment it appeared, and a control offering to move you should not itself move the thing
       * it is about.
       */}
      {/* 侧边聊天里划下的一段拿去侧边聊天问，问的就是它自己——只有主对话有。 */}
      {!side && <QuoteMenu scrollRef={scrollRef} />}
      {questions.length > 1 && !side && <QuestionNav key={activeSessionId} questions={questions} viewport={scrollRef} edge={narrowColumn} onSelect={jumpToQuestion} />}
      <BackToLatest
        show={follow.away || range.end < allBlocks.length}
        unread={follow.unread}
        onClick={() => { range.latest(); follow.returnToBottom(); }}
      />
      </div>

      {/*
       * Approvals sit directly above the composer.
       *
       * They used to be pinned to the bottom of the whole pane, which put them over the field
       * you type in — the one control you might want while deciding, and the place your eye is
       * already resting. A normal-flow card now reserves its own height, so the transcript
       * scrolls above the decision instead of disappearing behind it.
       */}
      <div className="relative shrink-0" style={docked ? { marginRight: ENVIRONMENT_LANE } : undefined}>
        <ApprovalOverlay renderPlan={planMarkdown} />
        {!side && <HookTrustBanner className={`${gutter} pb-1.5`} />}
        {/*
         * 只有卡片在的时候才留那道缝。清单是空的（或者做完收起了）时这一层什么都不画，
         * 却照样垫着 6px，输入框上方平白多出一截空白。
         */}
        {!roomToFloat && !side && (
          <div className={`${gutter} has-[[data-ly-task-list]]:pb-1.5`} data-ly-task-inline="">
            <div className="mx-auto w-full max-w-[var(--ly-content)]">
              <TaskList placement="inline" />
            </div>
          </div>
        )}
        {!side && <Composer />}
      </div>
    </div>
  );
});

/**
 * 环境卡片，和开着它时的任务清单——叠成一列，卡片在上。
 *
 * 两样都想要右上角那一块：任务清单本来就浮在那里。各占一个角会让一张盖住另一张，于是卡片开着时
 * 清单搬进这一列，排在卡片下面；卡片太长就自己滚，清单始终看得见。
 */
function EnvironmentLane({ card: Card, floatTasks }: { card: ComponentType; floatTasks: boolean }) {
  return (
    <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-20 flex flex-col gap-3" style={{ width: ENVIRONMENT_CARD }}>
      <Card />
      {floatTasks && (
        <div className="shrink-0">
          <TaskList placement="floating" />
        </div>
      )}
    </div>
  );
}

/**
 * Stand-in for a transcript that is still being read off disk.
 *
 * Opening a stored session replays its whole log and starts its MCP servers. The selection in
 * the sidebar lands immediately; without something here the main column would show the empty
 * state in the meantime, which reads as "this session has no messages".
 */
export function ConversationSkeleton() {
  const { compact } = useLayout();
  // Uneven widths so it reads as prose rather than as a loading bar.
  const rows = [72, 94, 61, 88, 47];

  return (
    <div data-ly-chat-surface="skeleton" className="flex min-h-0 flex-1 flex-col">
      <div
        className={`ly-defer-in min-h-0 flex-1 overflow-hidden ${compact ? "ly-content-gutter-compact" : "ly-content-gutter"}`}
        aria-busy
      >
        <div className="mx-auto w-full max-w-[var(--ly-content)] py-5">
          <div className="ly-pulse flex flex-col gap-3">
            <div className="ml-auto h-[38px] w-[45%] rounded-2xl rounded-br-md bg-card" />
            {rows.map((width, index) => (
              <div
                key={index}
                className="h-[13px] rounded bg-card"
                style={{ width: `${width}%` }}
              />
            ))}
            <div className="mt-2 h-[38px] w-full rounded-xl bg-card" />
          </div>
        </div>
      </div>

      <Composer />
    </div>
  );
}
