/**
 * What a browser opened through Web access may call.
 *
 * The browser runs the desktop's own renderer, and that renderer reaches for every method in
 * `METHODS`. Most of them cannot be offered over the network: `terminal.*` hands out a shell,
 * `files.remove` deletes from the project, `settings.save` rewrites the whole configuration,
 * `windows.*` and `screenshot.*` are about this machine's screen. What is left is the conversation
 * — read it, send to it, stop it, approve what it asks.
 *
 * Here rather than in the main process because both ends need the same answer: the main process
 * refuses anything not on it (`web-rpc.ts`, whose tests check it implements exactly this list), and
 * the renderer asks `available()` before drawing a control that would only fail. One list, so the
 * two cannot disagree.
 *
 * A token holder can still make the agent run commands inside an open project — `agent.prompt` is
 * the point of the feature. The token is to be kept like access to the machine, not like a link
 * to a transcript.
 */
export const WEB_METHODS: ReadonlySet<string> = new Set([
	"settings.get",
	"workspace.info",
	"sessions.list",
	"sessions.running",
	"sessions.create",
	"sessions.open",
	"sessions.transcript",
	"sessions.trajectory",
	"sessions.trajectoryChanges",
	"sessions.fork",
	"sessions.remove",
	"sessions.setArchived",
	"sessions.move",
	"sessions.capabilities",
	"sessions.rename",
	"sessions.compact",
	"sessions.contextBreakdown",
	"agent.prompt",
	"agent.editMessage",
	"agent.revertMessage",
	"agent.abort",
	"agent.approve",
	"agent.setModel",
	"agent.setThinking",
	"subAgents.list",
	"subAgents.detail",
	"subAgents.steer",
	"subAgents.abort",
	"subAgents.dismiss",
	"sideChat.setModel",
	"sideChat.state",
	"sideChat.ask",
	"sideChat.editAndResend",
	"sideChat.abort",
	"sideChat.reset",
	"sideChat.close",
	"tasks.list",
	"tasks.cancel",
	"tasks.dismiss",
	"tasks.resume",
	"files.list",
	"files.read",
	"commands.list",
	"git.generalScratch",
	"git.scratchRoots",
]);
