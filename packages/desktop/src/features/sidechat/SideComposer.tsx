/**
 * The same surface as the main composer, at panel scale.
 *
 * Not the main `Composer` component itself: that one sends to the active session and carries the
 * project and branch chips, slash commands and mentions. This one speaks to the session behind its
 * panel, which it creates on the first question (`askSide`), and follows the main session's model
 * unless told otherwise.
 */

import { useI18n } from "../../i18n/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import type { Message, SessionMeta } from "@plume/core";
import type { QueuedMessage } from "../../store/queue-slice.ts";
import { Plus } from "../../ui/icons/index.ts";
import { useEffect, useRef } from "react";
import { findModel } from "../models/index.ts";
import { askSide, openFilePane, setSideModel, setSideThinking, sideKey, useSide } from "../dock/index.ts";
import { sideDraftKey, useSideTarget } from "./target.ts";
import { useDockScope, useScopedMeta } from "../../app/session-scope.tsx";
import { useApp } from "../../store/index.ts";
import { sessionThinking } from "../../lib/thinking.ts";
import { withQuotes } from "../../lib/quote.ts";
import {
	ComposerSend,
	ComposerShell,
	ContextMeter,
	attachmentMeta,
	spellDraft,
	type DraftAttachment,
	QueueList,
	QuoteChip,
	queuePreview,
	queueThumbnail,
	useComposerAttachments,
	useDraft,
	useInputHistory,
} from "../composer/index.ts";
import { EffortTrigger, ModelTrigger } from "../models/index.ts";

const NO_MESSAGES: Message[] = [];
const NO_QUEUE: QueuedMessage[] = [];

export function SideComposer({
	side,
	disabled,
}: {
	/** The session behind this panel; null until the first question creates it. */
	side: SessionMeta | null;
	/** No session to be beside; the field stays visible but inert rather than vanishing. */
	disabled?: boolean;
}) {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	/*
	 * The conversation this side chat is beside, which is what 「跟随主会话」 follows. Not the live
	 * slot's `meta`: under another screen that named the focused conversation's model and effort.
	 */
	const meta = useScopedMeta();
	const { sessionId, sideId } = useSideTarget();
	// The screen this side chat is docked in, where a file marked here opens — not the one with focus.
	const screen = useDockScope();
	/** 标记点开的文件进右边的文件面板——和主输入框同一个去处，开在这一屏。 */
	const openFile = (path: string) => void openFilePane(path, screen ?? undefined);
	const sideId_ = side?.id ?? null;
	/*
	 * 空串是跟着主会话，见 core `AgentSession.modelIdInEffect`。会话还没建时，第一问会按设置里的
	 * 「侧边聊天默认模型」建（`openSideSession`），这里先照那个画，不然写着「跟随主会话」答话的却是另一个。
	 */
	const modelId = (side ? side.modelId : settings?.sideChatModelId) || null;
	const thinking = side?.thinking ?? null;
	/** 这一格的会话已经建了、记录还没读进来。 */
	const loading = useApp((s) => sideId_ !== null && !s.sessionCache[sideId_]);
	const running = useApp((s) => (sideId_ ? (s.sessionCache[sideId_]?.state?.running ?? false) : false));
	const messages = useApp((s) => (sideId_ ? (s.sessionCache[sideId_]?.messages ?? NO_MESSAGES) : NO_MESSAGES));
	const queued = useApp((s) => (sideId_ ? (s.queued[sideId_] ?? NO_QUEUE) : NO_QUEUE));
	/*
	 * 草稿按侧边聊天存，和主输入框同一个仓库——换个会话再回来，打了一半的话还在。关掉面板就是不要
	 * 这个侧边聊天了，草稿跟着扔，见 `closeSideChat`。
	 */
	const draftKey = sessionId ? sideDraftKey(sessionId, sideId) : null;
	const { text, setText, attachments, setAttachments, quotes, setQuotes, clear } = useDraft<DraftAttachment>(draftKey);
	const field = useRef<HTMLTextAreaElement>(null);
	/*
	 * 收附件的那一整套，和主输入框是同一份：八个的上限、PDF 抽字、上方只摆图片（文件在句子里那枚
	 * 标记上）、右键标记弹出同一份菜单。见 `useComposerAttachments`。
	 */
	const kit = useComposerAttachments<DraftAttachment>({ text, attachments, setAttachments, setText, field, openFile, thumbnail: 56 });
	const { marks } = kit;
	/* 方向键往回翻自己在这个侧边聊天里问过的话——和主输入框同一套手感。 */
	const history = useInputHistory({
		messages,
		value: text,
		attachments,
		onPick: (next, files) => {
			setText(next);
			setAttachments(files as DraftAttachment[]);
		},
		field,
		resetKey: draftKey ?? "",
	});

	/*
	 * Text handed back by withdrawing a task.
	 *
	 * Withdrawing is nearly always "not like that" rather than "never mind", so the wording comes
	 * back here to be edited and sent again instead of being thrown away. Appended rather than
	 * substituted when something is already half-typed: losing what you were writing to recover
	 * something you asked for is a bad trade.
	 */
	const draftSeed = useSide((s) => (sessionId ? s.draftSeeds[sideKey(sessionId, sideId)] : undefined));
	useEffect(() => {
		if (!draftSeed || !sessionId) return;
		/*
		 * 从仓库现取，不用闭包里那份：面板这一下才开时，StrictMode 会把这个 effect 连跑两遍，第二遍的
		 * `draftSeed` 还是旧值，同一段引文就接了两份。仓库里那份第一遍已经取走，第二遍读到的是空。
		 */
		const seed = useSide.getState().draftSeeds[sideKey(sessionId, sideId)];
		if (!seed) return;
		useSide.getState().clearDraftSeed(sessionId, sideId);
		const { text: handed, quotes: quoted } = seed;
		// 只隔一个换行，两段在 Markdown 里会并成同一段：和主输入框接一段进来时一样空一行。
		if (handed) setText((was) => (was.trim() ? `${was.replace(/\s+$/, "")}\n\n${handed}` : handed));
		if (quoted.length) setQuotes((was) => [...was, ...quoted]);
		// 送来的是半句话（退回的任务）或要问的材料（划下的一段），下一步总是接着写：光标放到末尾。
		const el = field.current;
		if (!el) return;
		// 面板还在从右侧滑入，默认聚焦会滚动外层容器、抵消滑入位移。
		el.focus({ preventScroll: true });
		requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
	}, [draftSeed, sessionId, sideId, setText, setQuotes]);

	const empty = !text.trim() && attachments.length === 0 && quotes.length === 0;

	function submit() {
		const trimmed = text.trim();
		if (empty || disabled || !sessionId) return;
		/*
		 * 和主输入框同一段：附件按标记在句子里的先后排，每份自带「第几张、共几张」。再交一份给人看的：
		 * 人打的那些字（`【图片 1】` 这样的标记留着），和附件的名字门类——没有这一份，气泡里摆的是
		 * 写给模型的 `### Attached file: …`。
		 */
		// 引文到这一刻才拼回引用块，排在要问的话前面——模型和气泡看到的都和从前一样。
		const said = withQuotes(trimmed, quotes);
		const content = spellDraft(said, attachments);
		const sent = { displayText: said, attachments: attachmentMeta(attachments) };
		/*
		 * 正在答的时候，排到后面，而不是什么都不发生。
		 *
		 * 从前这里直接 return：字留在框里，没有一句话说为什么，看着像回车键坏了。现在和主输入框一样
		 * 排在输入框上方那条上，这一轮答完自己发出去；条上改得了、删得掉、排得出先后。队里还压着
		 * 别的时候也排——不然新说的这句会越过前面那几句先到。
		 */
		if (sideId_ && (running || queued.length > 0)) {
			const composed = { text: trimmed, attachments, sessionRefs: [], quotes };
			const thumbnail = queueThumbnail(composed);
			const app = useApp.getState();
			app.enqueue(sideId_, {
				content,
				displayText: sent.displayText,
				...(sent.attachments.length ? { attachments: sent.attachments } : {}),
				draft: { text: trimmed, attachments, sessionRefs: [], quotes },
				preview: queuePreview(composed),
				...(thumbnail ? { thumbnail } : {}),
			});
			// 空着却排上了——上一轮被停掉、队里还压着别的：由这一次推它一把，和主输入框一样。
			if (!running) void app.flushQueue(sideId_);
			clear();
			return;
		}
		clear();
		void askSide(sessionId, sideId, content, sent);
	}

	const stop = () => {
		if (sideId_) void useApp.getState().abort(sideId_);
	};

	/** 排着的那一条退回来：整份草稿——字和附件——接在框里已有的后面。 */
	const restoreQueued = (entry: { draft: { text: string; attachments: unknown[]; quotes?: typeof quotes } }) => {
		setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${entry.draft.text}` : entry.draft.text));
		setAttachments((current) => [...current, ...(entry.draft.attachments as DraftAttachment[])]);
		if (entry.draft.quotes?.length) setQuotes((current) => [...current, ...entry.draft.quotes!]);
		const el = field.current;
		if (!el) return;
		el.focus();
		requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
	};

	// Inheritance stays a policy; the trigger names the model used by the next request.
	const model = findModel(settings, meta?.modelId ?? settings?.defaultModelId ?? null);
	const modelName = model?.name ?? null;

	/*
	 * `.ly-composer-pad` uses the same `--ly-composer-out` gutter as the main dock,
	 * minus `--ly-pane-chrome` on the bottom so the two cards share one window line.
	 */
	return (
		// Same cap as the transcript above it, so the field stays under the messages it answers.
		<div className="ly-composer-pad mx-auto w-full max-w-[var(--ly-content)] shrink-0">
			{sideId_ && (
				<QueueList
					source={{
						items: queued,
						drop: (id) => useApp.getState().dropQueued(sideId_, id),
						move: (id, targetId, placement) => void useApp.getState().moveQueued(sideId_, id, targetId, placement),
					}}
					running={running}
					onEdit={restoreQueued}
				/>
			)}
			<ComposerShell
				value={text}
				fieldRef={field}
				hint={
					history.position ? (
						<div data-ly-history="" className="ly-composer-hint text-caption text-ink-faint">
							{t("composer.history", { current: history.position.current, total: history.position.total })}
						</div>
					) : undefined
				}
				onChange={(next) => {
					setText(next);
					// 句子里那枚标记被删掉，附件跟着卸下来——删除是双向的。
					marks.reconcile(next);
				}}
				onKeyDown={(event) => {
					// 退格吃掉整枚标记，而不是把它啃成一串没人认得的方括号。
					if (marks.keyDown(event)) return;
					history.keyDown(event);
				}}
				onContextMenu={kit.onContextMenu}
				onAttachmentClick={kit.onAttachmentClick}
				decoration={{ attachments: marks.decorationFor(text) }}
				onSubmit={submit}
				disabled={disabled}
				placeholder={t(disabled ? "sideChat.noSession" : "sideChat.placeholder")}
				onFiles={(picked) => void kit.addFiles(picked)}
				attachments={
					/*
					 * 和主输入框同一排：只有图片，文件在句子里那枚标记上。只在真有图时展开，不然贴进来一个
					 * 文件，输入框上沿平白高出一道空的内衬。
					 */
					<div className="ly-reveal" data-open={kit.strip.length > 0 || quotes.length > 0 ? "true" : "false"}>
						<div className="ly-composer-attachments">
							{quotes.length > 0 && <QuoteChip quotes={quotes} onRemove={(id) => setQuotes((was) => was.filter((quote) => quote.id !== id))} />}
							{kit.stripNode}
						</div>
					</div>
				}
				left={
					<>
						<IconButton size="composer" emphasis label={t("composer.addAttachment")} onClick={kit.picker.open} icon={<Plus size={16} strokeWidth={1.9} />} />
						{kit.picker.input}
					</>
				}
				right={
					<>
						{/* 和主输入框同一只表，量的是这一格自己的会话：跟着主会话时，窗口也是主会话那个模型的。 */}
						<ContextMeter messages={messages} settings={settings} modelId={modelId || model?.id || null} sessionId={sideId_} running={running} openFile={openFile} />
						{/*
						 * 和主输入框同一枚，不是一个长得像它的。继承没被藏起来，只是挪进了提示里——见 `inheriting`。
						 */}
						<ModelTrigger
							modelId={modelId || model?.id}
							ariaLabel={t("sideChat.model")}
							inheriting={modelId ? undefined : t("sideChat.followMainLong")}
							disabled={disabled || loading}
							selection={{
								value: modelId ?? "",
								inheritLabel: t("sideChat.followMainLong"),
								inheritDetail: modelName ?? t("sideChat.noModel"),
								onChange: (value) => {
									if (sessionId) void setSideModel(sessionId, sideId, value);
								},
							}}
						/>
						{/*
						 * 想多久，也是这一条消息的属性。不选就还是跟着主会话走，也就是从前的行为。
						 */}
						<EffortTrigger
							modelId={modelId || model?.id}
							disabled={disabled || loading}
							selection={{
								modelId: modelId || model?.id,
								value: thinking ?? sessionThinking(meta, settings),
								onChange: (level) => {
									if (sessionId) void setSideThinking(sessionId, sideId, level);
								},
							}}
						/>
						{/* 正在答的时候按下去是排队，所以它说的也不再是「发送」——和主输入框同一个说法。 */}
						<div className="ly-queue-send" data-visible={running && !empty} inert={!running || empty}>
							<div>
								<ComposerSend running={false} active={running && !empty} disabled={!running || empty} tip={t("composer.queueWaiting")} onSend={submit} onStop={stop} />
							</div>
						</div>
						<ComposerSend running={running} disabled={empty || disabled} onSend={submit} onStop={stop} />
					</>
				}
			/>
			{kit.menu}
		</div>
	);
}
