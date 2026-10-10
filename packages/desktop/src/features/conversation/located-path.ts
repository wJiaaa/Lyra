/** 回复里一条相对路径在项目里指的那个文件，找的规矩见 `services/locate.ts`。 */

import { useEffect, useState } from "react";
import { locatedFile, locateFile } from "../../services/index.ts";

/** `project` 为 null 时不查，返回 null，调用方照旧按工作目录拼。 */
export function useLocatedPath(project: string | null, relative: string): string | null {
	const key = project ? `${project}\0${relative}` : null;
	const [located, setLocated] = useState<{ key: string; path: string } | null>(null);
	useEffect(() => {
		if (!project || !key || locatedFile(project, relative)) return;
		let alive = true;
		void locateFile(project, relative).then((path) => {
			if (alive && path) setLocated({ key, path });
		});
		return () => {
			alive = false;
		};
	}, [project, relative, key]);
	if (!project || !key) return null;
	return locatedFile(project, relative) ?? (located?.key === key ? located.path : null);
}
