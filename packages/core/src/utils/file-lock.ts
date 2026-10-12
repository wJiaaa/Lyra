/**
 * 跨进程的互斥：同一台机器上的几个 Plume 进程（桌面端、命令行）轮流做一件事。
 *
 * 锁是一个文件，用 `open(path, "wx")` 建——「不存在才建」在 POSIX 和 Windows 上都是原子的，不靠
 * `flock`（Windows 没有）也不靠端口。持有期间每隔一段时间刷新它的修改时间；一个持有者崩了、锁没
 * 删，过了 `staleMs` 没刷新就算死锁，接手。放锁时只删写着自己令牌的那个：自己的锁被当成过期接手
 * 之后，不能再把别人的删掉。
 *
 * 已知的窄缝：两个进程同时判定同一把锁过期时，后删的那个可能删掉先到者刚建的新锁。要撞上它，
 * 得有一个持有者先失联 `staleMs` 那么久，再有两个等的人在同一刻醒来——比不加锁时「每次同时刷新
 * 就互相踢掉」窄得多。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
	/** 多久没刷新就当持有者已经不在了。默认 30 秒。 */
	staleMs?: number;
	/** 最多等多久；到了就抛错，不在没拿到锁的情况下往下做。默认比 `staleMs` 多 10 秒，总能等到一把过期锁。 */
	waitMs?: number;
}

export async function withFileLock<T>(path: string, run: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
	const staleMs = options.staleMs ?? 30_000;
	const waitMs = options.waitMs ?? staleMs + 10_000;
	const token = `${process.pid} ${randomUUID()}`;
	await mkdir(dirname(path), { recursive: true });
	const deadline = Date.now() + waitMs;
	for (let round = 0; ; round++) {
		try {
			const handle = await open(path, "wx");
			try {
				await handle.writeFile(token);
			} finally {
				await handle.close();
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const held = await stat(path).catch(() => null);
			if (held && Date.now() - held.mtimeMs > staleMs) {
				await rm(path, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out after ${waitMs}ms waiting for the lock ${path}`, { cause: error });
			// 退避加抖动：几个进程同时等时别踩着同一个节拍去抢。
			await new Promise((resolve) => setTimeout(resolve, Math.min(200, 10 * 2 ** Math.min(round, 4)) + Math.random() * 20));
		}
	}
	const keepAlive = setInterval(() => {
		const now = new Date();
		void utimes(path, now, now).catch(() => {});
	}, Math.max(1000, staleMs / 3));
	keepAlive.unref?.();
	try {
		return await run();
	} finally {
		clearInterval(keepAlive);
		const current = await readFile(path, "utf8").catch(() => null);
		if (current === token) await rm(path, { force: true }).catch(() => {});
	}
}
