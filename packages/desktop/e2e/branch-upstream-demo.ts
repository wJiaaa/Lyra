/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * The branch chip under the composer says how far the branch is from its upstream: `↑3 ↓1` with three
 * commits not pushed and one fetched but not pulled, nothing once it is level, and nothing for a branch
 * that tracks no remote. Pushed from a terminal, it follows when the window comes back to the front.
 *
 *   node --experimental-strip-types e2e/branch-upstream-demo.ts      # screenshots into the Desktop folder `OUT` names
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9482;
const OUT = join(homedir(), "Desktop", "Plume分支远端状态测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}\n     ${detail}`);
}

let app: RunningApp;
async function shot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT, `${stamp}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   📸 ${file}`);
}

/** The branch chip as drawn: its label, its marks and its tooltip. */
const CHIP = `(() => {
	const chip = [...document.querySelectorAll(".ly-composer-tray button")].find((b) => b.querySelector(".lucide-git-branch"));
	return chip ? { text: chip.textContent, marks: chip.querySelector("[data-ly-distance-marks]")?.textContent ?? "", tip: chip.getAttribute("data-ly-tip") } : null;
})()`;

async function main() {
	await mkdir(OUT, { recursive: true });
	const parent = await mkdtemp(join(tmpdir(), "plume-upstream-"));
	const remote = join(parent, "remote.git");
	const project = join(parent, "demo-repo");
	const other = join(parent, "other");
	const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=probe@example.com", "-c", "user.name=Probe", ...args], { cwd, encoding: "utf8" }).trim();
	await mkdir(remote);
	await mkdir(project);
	gitIn(remote, "init", "--bare", "--initial-branch=main");
	gitIn(project, "init", "--initial-branch=main");
	await writeFile(join(project, "README.md"), "# demo\n");
	gitIn(project, "add", ".");
	gitIn(project, "commit", "-qm", "init");
	gitIn(project, "remote", "add", "origin", remote);
	gitIn(project, "push", "-qu", "origin", "main");
	// Someone else pushed one; fetched here, not pulled.
	gitIn(parent, "clone", "-q", remote, other);
	await writeFile(join(other, "theirs.md"), "theirs\n");
	gitIn(other, "add", ".");
	gitIn(other, "commit", "-qm", "theirs");
	gitIn(other, "push", "-q");
	gitIn(project, "fetch", "-q");
	for (const name of ["a", "b", "c"]) {
		await writeFile(join(project, `${name}.md`), `${name}\n`);
		gitIn(project, "add", ".");
		gitIn(project, "commit", "-qm", `add ${name}`);
	}

	app = await startApp({
		port: PORT,
		seed: async (dir) => {
			await writeFile(join(dir, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
			await writeFile(join(dir, "settings.json"), JSON.stringify({ projects: [{ path: project, name: "演示仓库", pinned: true, lastOpenedAt: Date.now() }] }));
		},
	});
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	const { until, click, markByText } = driver(app);
	const chip = () => app.evaluate<{ text: string; marks: string; tip: string } | null>(CHIP);
	const comeBack = async () => {
		await app.evaluate(`window.dispatchEvent(new Event("focus"))`);
		await pause(1200);
	};
	try {
		await app.evaluate("document.fonts.ready");
		await until(`document.querySelector(".ly-composer-tray .lucide-git-branch")`, 20000);
		await until(`document.querySelector("[data-ly-distance-marks]")`, 10000).catch(() => {});
		await pause(1200);

		const first = await chip();
		check("3 个没推、1 个没拉：chip 上是 ↑3↓1", first?.marks === "↑3↓1", JSON.stringify(first));
		check("悬停说清楚和谁比", first?.tip === "main：比 origin/main 领先 3、落后 1（以上次获取为准）", first?.tip ?? "");
		await shot("01_领先3落后1");

		console.log("② 在终端里拉下来再推上去，窗口回到前台");
		gitIn(project, "pull", "-q", "--no-rebase", "--no-edit");
		gitIn(project, "push", "-q");
		await comeBack();
		const level = await chip();
		check("和远端一致：chip 上没有数字，悬停说一致", level?.marks === "" && level.text === "main" && level.tip === "main：和 origin/main 一致（以上次获取为准）", JSON.stringify(level));
		await shot("02_和远端一致");

		console.log("③ 在分支菜单里切到一个从没推过的分支");
		gitIn(project, "branch", "feature");
		await click(".ly-composer-tray button:has(.lucide-git-branch)");
		await pause(900);
		await markByText("/^feature/", "data-probe-branch");
		await click("[data-probe-branch]");
		await until(`[...document.querySelectorAll(".ly-composer-tray button")].some((b) => b.textContent.startsWith("feature"))`, 15000);
		await pause(1200);
		const fresh = await chip();
		check("没有跟踪远端：只有分支名", fresh?.marks === "" && fresh.tip === "feature", JSON.stringify(fresh));
		await shot("03_没有远端分支");
	} finally {
		await stop();
		const passed = results.filter((result) => result.ok).length;
		if (frames.length) {
			const file = join(OUT, `${stamp}_分支远端状态_${passed}of${results.length}.mp4`);
			await encode(frames, file, 30, 1500);
			console.log(`🎬 ${file}`);
		}
		await app.stop();
		await rm(parent, { recursive: true, force: true });
		console.log(`\n${passed}/${results.length} 通过`);
		if (passed !== results.length) process.exitCode = 1;
	}
}

void main();
