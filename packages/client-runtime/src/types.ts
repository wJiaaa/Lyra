import type { AgentEvent, ApprovalRequest, Message, SessionMeta, ThinkingLevel } from "@plume/core/client-types";

/** `relay` 为真时 `url` 是中转服务的 WebSocket 地址，否则是电脑的 HTTP 地址。 */
export interface Connection { url: string; token: string; relay?: boolean }
/** 一张随消息发出的图片，`data` 是不带 `data:` 前缀的 base64。 */
export interface PromptImage { data: string; mimeType: string }
/** `images` 为假时这个模型看不到图：core 会把图换成一句占位，手机就不提供加图。 */
export interface MobileModel { id: string; name: string; provider: string; images: boolean; thinkingOptions: { value: string; label: string }[] }
export interface Bootstrap {
	name: string;
	projects: { id: string; name: string; path: string }[];
	models: MobileModel[];
	defaultModelId: string;
	thinking: ThinkingLevel;
	sessions: SessionMeta[];
	runningSessionIds: string[];
}
export interface SessionSnapshot {
	meta: SessionMeta;
	messages: Message[];
	running: boolean;
	pendingApprovals: (ApprovalRequest & { id: string; expiresAt?: number })[];
}
export type RemoteEvent =
	| { type: "agent_event"; sessionId: string; event: AgentEvent }
	| { type: "session_changed"; change: { id: string; projectId: string; meta: SessionMeta | null } }
	| { type: "bootstrap_changed" };
export interface ClientState {
	status: "offline" | "connecting" | "connected" | "reconnecting";
	bootstrap: Bootstrap | null;
	activeId: string | null;
	session: SessionSnapshot | null;
	loading: boolean;
	error: string | null;
}
