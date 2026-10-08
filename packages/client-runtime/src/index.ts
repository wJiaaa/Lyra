export { RemoteClient } from "./client.ts";
export type { Message, SessionMeta, ApprovalDecision, ApprovalRequest } from "@plume/core/client-types";
export { RemoteTransport } from "./transport.ts";
export { normalizeConnection, pairingCode, parsePairingCode } from "./connection.ts";
export { relayRoom, relaySocketUrl } from "./relay.ts";
export { messageEvent } from "./message-event.ts";
export { applySessionEvent } from "./session-event.ts";
export type { Bootstrap, ClientState, Connection, MobileModel, PromptImage, SessionSnapshot, RemoteEvent } from "./types.ts";
