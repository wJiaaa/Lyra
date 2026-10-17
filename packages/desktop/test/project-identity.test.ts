/**
 * 项目按 id 认、会话只认自己记下的项目以后，「这条会话归谁」的几条规则。
 *
 * 一个文件夹可以在好几个项目里，所以文件夹回答不了归属；会话记下的项目是唯一的答案。没记的——在
 * 单独打开的文件夹里开的——不属于任何项目，哪怕那个文件夹正是某个项目的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { folderChoiceName, onePerFolder, pathHints, projectLabel, projectSessions, sessionProject } from "../src/lib/project-identity.ts";

const one = { id: "uuid-1", path: "/w/app", name: "app" };
const two = { id: "uuid-2", path: "/w/app", name: "B" };
const core = { id: "uuid-3", path: "/w/app/packages/core", name: "core" };

const at = (id: string, cwd: string, project?: string) => ({ id, cwd, projectName: cwd.split("/").pop()!, ...(project ? { project } : {}) });

test("a conversation belongs to the project it records, and only that one", () => {
	const projects = [one, two, core];
	assert.equal(sessionProject(projects, at("a", "/w/app", two.id))?.id, two.id);
	assert.equal(sessionProject(projects, at("b", "/w/app")), undefined, "in a project's folder, but recording none");
	assert.equal(sessionProject(projects, at("c", "/w/app/packages/core/src")), undefined, "nothing is read off the folder");
	assert.equal(sessionProject(projects, at("d", "/w/app", "removed")), undefined, "a removed project takes nothing along");
});

test("archiving a project takes the conversations that record it, wherever they run", () => {
	const sessions = [at("a", "/w/app", one.id), at("b", "/w/app", two.id), at("c", "/elsewhere", one.id), at("d", "/w/app")];
	assert.deepEqual(projectSessions(sessions, one.id).map((s) => s.id), ["a", "c"]);
	assert.deepEqual(projectSessions(sessions, two.id).map((s) => s.id), ["b"]);
});

/*
 * 提示要落在不同的那一截上。整条路径显示时，两行都是 `~/work/…`，正好在分叉处被截断。
 */
test("names that collide carry as much of their parent folder as tells them apart, and no more", () => {
	const hints = pathHints([
		{ id: "1", name: "app", path: "/Users/x/work/a/app" },
		{ id: "2", name: "app", path: "/Users/x/work/b/app" },
		{ id: "3", name: "api", path: "/Users/x/work/api" },
	]);
	assert.deepEqual([...hints], [["1", "a"], ["2", "b"]]);
});

test("the hint reads further back only when the nearest folders are the same", () => {
	const hints = pathHints([
		{ id: "1", name: "app", path: "/one/src/app" },
		{ id: "2", name: "app", path: "/two/src/app" },
	]);
	assert.deepEqual([...hints], [["1", "one/src"], ["2", "two/src"]]);
});

test("two projects on one folder under one name get the same hint rather than none", () => {
	const hints = pathHints([
		{ id: "1", name: "app", path: "/w/app" },
		{ id: "2", name: "app", path: "/w/app" },
	]);
	assert.deepEqual([...hints], [["1", "w"], ["2", "w"]]);
});

test("a choice about the folder lists each folder once", () => {
	assert.deepEqual(onePerFolder([one, two, core]).map((p) => p.id), [one.id, core.id]);
});

// What is set per folder is shared by every project on it; the choice says so by naming them all.
test("a choice about the folder is named for every project on it", () => {
	assert.equal(folderChoiceName([one, two, core], "/w/app", "en"), "app and B");
	assert.equal(folderChoiceName([one, two, core], "/w/app", "zh-CN"), "app和B");
	assert.equal(folderChoiceName([one, two, core], core.path, "en"), "core");
});

test("a conversation is captioned with its project's name now, or its folder's when it has none", () => {
	const renamed = { ...one, name: "后端" };
	assert.equal(projectLabel([renamed], at("a", "/w/app", one.id)), "后端");
	assert.equal(projectLabel([one, two], at("b", "/w/app", two.id)), "B");
	assert.equal(projectLabel([one], at("c", "/w/app")), "app", "in no project: the folder's name");
	assert.equal(projectLabel([], at("d", "/w/app", one.id)), "app", "its project removed: the folder's name");
});
