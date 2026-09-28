import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDefinitionRecord, ProjectEntry } from "@plume/core";
import { bridge } from "../../services/index.ts";

/** `project` 是页面上选中的项目，null 是用户级。 */
export function useAgentDefinitions(project: ProjectEntry | null) {
	const projectId = project?.id ?? null;
	const [records, setRecords] = useState<AgentDefinitionRecord[] | null>(null);
	const [tools, setTools] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);
	const refresh = useCallback(async () => {
		const current = ++generation.current;
		setBusy(true); setError("");
		try {
			const result = await bridge.agentDefinitions.list(projectId);
			if (current === generation.current) { setRecords(result.records); setTools(result.tools); }
		} catch (cause) { if (current === generation.current) setError(String(cause)); }
		finally { if (current === generation.current) setBusy(false); }
	}, [projectId]);
	useEffect(() => {
		const invalidate = () => { generation.current++; };
		setRecords(null); void refresh(); return invalidate;
	}, [refresh]);
	return { records, tools, error, busy, refresh, projectId, projectName: project?.name };
}
