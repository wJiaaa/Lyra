/** 独立手机界面只用这组接口，不把整个桌面 IPC 暴露到网络上。 */
export const MOBILE_METHODS = [
	"bootstrap", "sessions.list", "sessions.get", "sessions.create", "sessions.rename", "sessions.archive",
	"agent.prompt", "agent.abort", "agent.approve", "agent.setModel", "agent.setThinking",
] as const;
export type MobileMethod = typeof MOBILE_METHODS[number];

export interface MobileAccessStatus {
	running: boolean;
	port: number;
	addresses: string[];
	token: string | null;
	clients: number;
	/** `state` 在没填中转或访问关着时是 `off`；`paired` 表示此刻有一部手机经中转连着。 */
	relay: { url: string; state: "off" | "connecting" | "online" | "paired" };
}
