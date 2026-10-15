/**
 * 对话，对外的那一面。
 *
 * 别的域只能从这里拿东西，不能伸进这个目录里的文件——那条规则由 `pnpm arch` 执行。
 *
 * 这张表也是这个域的公开承诺：里面的东西改了签名，别处会跟着断；不在里面的可以随便动。
 * 它短是件好事。要往里加之前先想想，是不是那件事本来就该发生在这个域里面。
 */

export { BackToLatest } from "./BackToLatest.tsx";
export { Markdown } from "./Markdown.tsx";
export { MessageActions } from "./MessageActions.tsx";
export { HookRunsButton } from "./HookRunsAction.tsx";
export { formatTokens } from "../../lib/format-tokens.ts";
export { SessionStatus } from "./SessionStatus.tsx";
/* 建议新会话的「开始」那一排：环境卡片那一节和对话里的卡片问同一个问题。 */
export { SuggestionStart } from "./SessionSuggestionCard.tsx";
export { ThinkingBlock } from "./ThinkingBlock.tsx";
export { DetailCard } from "./detail/DetailCard.tsx";
export { runs, runKey, withoutThinking } from "./grouping.ts";
export { ModelSwitchRow } from "./ModelSwitchRow.tsx";
export { ToolRun, segments } from "./runs.tsx";
/* 人说的一句话画成气泡——侧边聊天和子智能体面板共用，见 `SpokenBubble`。 */
export { SpokenBubble, spokenText } from "./SpokenBubble.tsx";
export { TrajectoryPanel } from "./trajectory/TrajectoryPanel.tsx";
export { useDeliveryReview, useSharedDeliveryTarget } from "./delivery-review.ts";
export { announceUndo, useDeliveryUndos } from "./delivery-undo.ts";
export { usePathMenu } from "./PathMenu.tsx";
export { TraceText } from "./detail/TraceText.tsx";
export { showTrace } from "./trajectory/navigation.ts";
/* 画廊里点「在对话中查看」：那个对话一读完，就把那张图滚到中间、闪一下。 */
export { revealDrawing } from "./reveal.ts";
export { Conversation, ConversationSkeleton } from "./Conversation.tsx";
export { EmptyState } from "./EmptyState.tsx";
/* 回到会话时的那张回顾卡：壳挂到达的监听。 */
