/** 回复里一条相对路径在项目里对应的文件，找的规矩见 `services/locate.ts`。 */

import { useEffect, useState } from "react";
import { locatedFiles, locateFiles } from "../../services/index.ts";

const NONE: readonly string[] = [];

/** 项目里所有对得上的文件，还没找到或 `project` 为 null 时是空的，调用方照旧按工作目录拼。 */
export function useLocatedPaths(project: string | null, relative: string): readonly string[] {
	const key = project ? `${project}\0${relative}` : null;
	const [located, setLocated] = useState<{ key: string; paths: readonly string[] } | null>(null);
	useEffect(() => {
		if (!project || !key || locatedFiles(project, relative)) return;
		let alive = true;
		void locateFiles(project, relative).then((paths) => {
			if (alive && paths.length) setLocated({ key, paths });
		});
		return () => {
			alive = false;
		};
	}, [project, relative, key]);
	if (!project || !key) return NONE;
	return locatedFiles(project, relative) ?? (located?.key === key ? located.paths : NONE);
}
