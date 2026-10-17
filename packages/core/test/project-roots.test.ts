/**
 * A project may be several folders, and everything downstream has to agree on which ones.
 *
 * The rules worth stating: an entry written before the field existed still means its one folder;
 * only the project a session records answers, never the folder it runs in; and a folder that merely
 * shares a name prefix with a project folder is not inside it — the `p-old` ⊄ `p` trap the read
 * boundary has to avoid, tested here because this is where the answer is decided.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { projectFolders } from "../src/config/project-folders.ts";
import { projectRootsFor } from "../src/config/project-roots.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { buildTurnConfig } from "../src/runtime/turn-config.ts";
import { assessRead } from "../src/tools/read-access.ts";

const HOME = homedir();
const APP = join(HOME, ".plume-test-app");
const API = join(HOME, ".plume-test-api");
const ELSEWHERE = join(HOME, ".plume-test-elsewhere");

function entry(path: string, folders?: string[]) {
	return { id: path, path, folders };
}

// ---------------------------------------------------------------- reading the entry

test("an entry from before multi-folder projects means its one folder", () => {
	assert.deepEqual(projectFolders({ path: APP }), [APP]);
	assert.deepEqual(projectFolders({ path: APP, folders: [] }), [APP]);
});

test("the main folder comes first however the list was written", () => {
	assert.deepEqual(projectFolders({ path: APP, folders: [API, APP] }), [APP, API]);
	assert.deepEqual(projectFolders({ path: APP, folders: [APP, API] }), [APP, API]);
});

test("a folder named twice is one folder", () => {
	assert.deepEqual(projectFolders({ path: APP, folders: [API, API, APP] }), [APP, API]);
});

/*
 * An entry that lost its own path is not a state to propagate.
 *
 * It cannot be produced through the dialog, but settings are a file on disk that people edit. The
 * answer that keeps every caller sane is "the working directory is part of the project", because
 * the alternative is a file tree rooted outside the session and a read boundary that asks about
 * the directory the session is running in.
 */
test("the main folder is included even if the list forgot it", () => {
	assert.deepEqual(projectFolders({ path: APP, folders: [API] }), [APP, API]);
});

// ---------------------------------------------------------------- finding the project

test("a session in a project gets that project's folders", () => {
	const projects = [entry(APP, [APP, API])];
	assert.deepEqual(projectRootsFor(projects, APP, APP), [APP, API]);
	assert.deepEqual(projectRootsFor(projects, join(APP, "packages/core"), APP), [APP, API]);
});

test("a session inside an extra folder gets the same set", () => {
	const projects = [entry(APP, [APP, API])];
	assert.deepEqual(projectRootsFor(projects, join(API, "src"), APP), [APP, API]);
});

test("a session in no project gets nothing", () => {
	assert.deepEqual(projectRootsFor([entry(APP, [APP, API])], ELSEWHERE, undefined), []);
	assert.deepEqual(projectRootsFor([], APP, APP), []);
	assert.deepEqual(projectRootsFor(undefined, APP, APP), []);
});

/*
 * The folder is not asked.
 *
 * One folder can be in several projects, so "which project lists the folder this runs in" is a
 * guess. A session that names no project — started on a folder opened on its own — reads its
 * own cwd and nothing more, even when that folder is some project's.
 */
test("a session that names no project gets nothing, even in a project's folder", () => {
	assert.deepEqual(projectRootsFor([entry(APP, [APP, API])], APP, undefined), []);
	assert.deepEqual(projectRootsFor([entry(APP, [APP, API])], APP, "gone"), [], "a project removed since takes its folders with it");
});

/*
 * Two projects on one checkout list different extra folders; only the session knows which it is in.
 * A session whose `cwd` is outside the named project — a worktree — does not reach back into it.
 */
test("a session gets the folders of the project it names, not of another on the same folder", () => {
	const one = { id: "one", path: APP, folders: [APP, API] };
	const two = { id: "two", path: APP };
	assert.deepEqual(projectRootsFor([one, two], APP, "one"), [APP, API]);
	assert.deepEqual(projectRootsFor([one, two], APP, "two"), [APP]);
	assert.deepEqual(projectRootsFor([one, two], ELSEWHERE, "one"), [], "outside its folders");
});

test("a shared name prefix is not containment", () => {
	assert.deepEqual(projectRootsFor([entry(APP, [APP, API])], `${APP}-old`, APP), []);
	assert.deepEqual(projectRootsFor([entry(APP, [APP, API])], `${API}-old`, APP), []);
});

// ---------------------------------------------------------------- what it changes

test("the project's other folders are readable without asking", () => {
	const roots = projectRootsFor([entry(APP, [APP, API])], APP, APP);
	assert.equal(assessRead(join(API, "src/server.ts"), APP, { projectRoots: roots }).decision, "allow");
	assert.equal(assessRead(API, APP, { projectRoots: roots }).decision, "allow");
});

test("a one-folder project changes nothing about what is asked", () => {
	const roots = projectRootsFor([entry(APP)], APP, APP);
	assert.equal(assessRead(join(API, "src/server.ts"), APP, { projectRoots: roots }).decision, "ask");
	assert.equal(assessRead(join(API, "src/server.ts"), APP).decision, "ask");
});

/*
 * Adding a folder to a project says "this is mine to work on", not "read the keys I keep in it".
 *
 * The credential rule runs before every containment check, including the cwd's own, so this is
 * asserting that the new root was added to the right side of that line.
 */
test("a credential inside a project folder is still a question", () => {
	const roots = projectRootsFor([entry(APP, [APP, join(HOME, ".ssh")])], APP, APP);
	const verdict = assessRead(join(HOME, ".ssh", "id_ed25519"), APP, { projectRoots: roots });
	assert.equal(verdict.decision, "ask");
	assert.equal(verdict.decision === "ask" && verdict.scope, "file");
});

// ---------------------------------------------------------------- the seam

/*
 * The rule and the judgement are both right above; this is the wiring between them.
 *
 * "The code is there, the feature is not" is the failure mode this repository keeps meeting, and
 * its usual shape is exactly this: a value computed correctly, judged correctly, and never handed
 * from one to the other. `buildTurnConfig` is the only place that reads the project list on behalf
 * of a turn, and `tool-run.ts` is the only place that puts it on a `ToolContext` — so a turn built
 * without it means every tool in the session asks about the second folder, with nothing failing.
 */
test("a turn built from settings carries the project's folders to its tools", () => {
	const settings = { ...DEFAULT_SETTINGS, projects: [{ id: "app", name: "app", path: APP, pinned: false, lastOpenedAt: 1, folders: [APP, API] }] };
	const config = buildTurnConfig(
		{
			sessionId: "seam",
			cwd: APP,
			project: "app",
			provider: { id: "p", name: "p", baseUrl: "", api: "openai", apiKey: "", enabled: true, models: [] },
			model: { id: "m", name: "m", modelId: "m", providerId: "p" },
			settings,
			state: new Map(),
			tools: [],
			skills: [],
			agents: [],
			requestApproval: async () => "reject",
			emit: async () => {},
			beforeToolCall: undefined,
			afterToolCall: undefined,
			drainSteering: undefined,
		} as unknown as Parameters<typeof buildTurnConfig>[0],
		{ systemPrompt: "", messages: [], tools: [], cwd: APP },
		"",
	);
	assert.deepEqual(config.tools.env.projectRoots, [APP, API]);
});

test("a turn in a one-folder project carries nothing extra", () => {
	const settings = { ...DEFAULT_SETTINGS, projects: [{ id: "app", name: "app", path: APP, pinned: false, lastOpenedAt: 1 }] };
	const config = buildTurnConfig(
		{
			sessionId: "seam",
			cwd: APP,
			project: "app",
			provider: { id: "p", name: "p", baseUrl: "", api: "openai", apiKey: "", enabled: true, models: [] },
			model: { id: "m", name: "m", modelId: "m", providerId: "p" },
			settings,
			state: new Map(),
			tools: [],
			skills: [],
			agents: [],
			requestApproval: async () => "reject",
			emit: async () => {},
		} as unknown as Parameters<typeof buildTurnConfig>[0],
		{ systemPrompt: "", messages: [], tools: [], cwd: APP },
		"",
	);
	assert.deepEqual(config.tools.env.projectRoots, [APP]);
});

/*
 * And the model has to be told, or the folder is readable and never read.
 *
 * The read rule allowing something silently is worth nothing: the model still believes the second
 * repository is off-limits, so it never opens it. The prompt also has to say what did *not* change
 * — writing there is refused outright — because an unexplained refusal is what taught it to reach
 * for `sed` in a shell in the first place.
 */
test("the system prompt names the other folders, and only when there are any", async () => {
	const base = {
		cwd: APP,
		tools: [],
		skills: [],
		projectInstructions: [],
		platform: "darwin",
		modelName: "m",
		isGitRepo: false,
	} as unknown as Parameters<typeof buildSystemPrompt>[0];

	const plain = await buildSystemPrompt(base);
	assert.ok(!plain.includes(API.replace(/\\/g, "/")), "a one-folder project must not pay a single token for this");

	const multi = await buildSystemPrompt({ ...base, projectRoots: [APP, API] });
	assert.ok(multi.includes(API.replace(/\\/g, "/")), "the extra folder is not named anywhere in the prompt");
	assert.equal(multi.split(APP.replace(/\\/g, "/")).length - 1, 1, "the working directory is repeated as if it were a second fact");
	assert.match(multi, /Writing there is not free/, "the prompt does not say writing there still asks");
});
