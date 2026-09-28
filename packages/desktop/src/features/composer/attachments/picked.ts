/**
 * 一批刚被放进来的文件，连同它们在磁盘上的位置。
 *
 * 位置是这一层存在的全部理由。`File` 对象本身答不了「它从哪儿来」——Electron 32 之后 `File.path`
 * 就没了，替代品 `webUtils.getPathForFile` 只在 preload 里有。没有它，一份拖进来的表格在附件条
 * 上就只是一个名字：打不开，也指不出它在哪，而那个文件明明就躺在 `~/下载` 里。
 *
 * 同步取，在拿到 `FileList` 的那一刻。`pathForDrop` 本身是同步的，而调用它的时机不能拖到 await
 * 之后——drop 事件返回时 `DataTransfer` 就被清空了。三条路（拖、贴、选）都走这里，免得其中一条
 * 忘了取路径，而那种缺失只在「点开菜单发现全是灰的」时才看得出来。
 */

import { bridge } from "../../../services/index.ts";

export interface PickedFile {
	file: File;
	/**
	 * 它在磁盘上的位置，有的话。
	 *
	 * 粘贴进来的截图没有：剪贴板给的是一团像素，从来不是某个文件。浏览器里跑的时候也没有——
	 * `pathForDrop` 是 Electron 的东西。
	 */
	path?: string;
}

export function pickedFrom(list: FileList | null | undefined): PickedFile[] {
	if (!list) return [];
	/*
	 * 问桥本身有没有这个方法。
	 *
	 * `pathForDrop` 不在契约表（`@lyra/contract` 的 `METHODS`）里——它不是一次 IPC，是 preload 里
	 * 手写的一个同步调用，`webUtils` 只有那儿有。按契约表去问会永远答 false，路径一次都取不到。
	 *
	 * 这类判断只有一种可靠问法：那个函数在不在。
	 */
	const canAsk = typeof bridge.files?.pathForDrop === "function";
	return Array.from(list).map((file) => {
		if (!canAsk) return { file };
		/*
		 * 取不到就是没有，不是错。
		 *
		 * 剪贴板里的图片在这里会拿到空串——它本来就不是一个文件。包一层是因为「方法在」不等于「此刻
		 * 调它不会抛」，而这是一次同步调用，抛出来就直接掀掉了整个 drop 处理。
		 */
		try {
			const path = bridge.files.pathForDrop(file);
			return path ? { file, path } : { file };
		} catch {
			return { file };
		}
	});
}

/**
 * 拖进来的一批，文件夹单独拣出来。
 *
 * 文件夹在 `files` 里也是一个 `File`：没有类型、读它的字节会失败。当附件读，结果是一条「无法读取」
 * 和一个什么都没收下的输入框。它该是一条 `@` 引用——和「@ → 选择文件夹」落下的是同一种东西，所以
 * 这里只交出它的路径。取不到路径的（浏览器里跑）就没有，不当错报。
 *
 * 是不是文件夹只有 `items` 答得出，而且同样只在 drop 事件里答得出。`files` 就是按顺序排的那几个
 * `kind === "file"` 的 item，所以按下标对得上。这些都在第一个 `await` 之前取完——函数返回时
 * `DataTransfer` 已经空了，之后只剩手里的 `File` 和路径。
 *
 * `webkitGetAsEntry()` 也可能答不上来（返回 null）。那时读一个字节试试：文件夹读不出字节，而一份
 * 读不出字节、却有路径的东西，当附件只会落一条「无法读取」，写成引用至少还指得到它。
 */
export async function droppedFrom(transfer: DataTransfer): Promise<{ files: PickedFile[]; folders: string[] }> {
	const entries = Array.from(transfer.items).filter((item) => item.kind === "file");
	const dropped = pickedFrom(transfer.files).map((picked, index) => ({
		picked,
		/** `undefined` 是「没答上来」，不是「不是文件夹」。 */
		directory: entries[index]?.webkitGetAsEntry()?.isDirectory,
	}));

	const files: PickedFile[] = [];
	const folders: string[] = [];
	for (const { picked, directory } of dropped) {
		const folder =
			directory ?? (picked.path !== undefined && !(await picked.file.slice(0, 1).arrayBuffer().then(() => true, () => false)));
		if (!folder) files.push(picked);
		else if (picked.path) folders.push(picked.path);
	}
	return { files, folders };
}
