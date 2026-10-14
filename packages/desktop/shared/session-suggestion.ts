/**
 * What a `spawn_session` call leaves for the card that draws it.
 *
 * The main process writes it as the tool result's `details`, which the log keeps: a conversation
 * reopened tomorrow still has its card, with the prompt it would start with. The renderer reads it
 * back to draw the card (`SessionSuggestionCard`). Here because both sides need the shape.
 */

export const SPAWN_SESSION_TOOL = "spawn_session";
export const ARCHIVE_SESSION_TOOL = "archive_session";

export interface SessionSuggestionDetails {
	kind: "session_suggestion";
	title: string;
	summary: string;
	prompt: string;
}
