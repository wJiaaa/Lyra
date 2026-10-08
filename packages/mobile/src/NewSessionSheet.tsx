import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { Bootstrap, RemoteClient } from "@plume/client-runtime";
import { ChoiceList, ChoiceSheet } from "./ChoiceSheet.tsx";
import { Sheet } from "./Sheet.tsx";
import { Button, Eyebrow, Group, GroupRow, Txt, useTheme } from "./ui.tsx";
import type { T } from "./i18n.ts";

/** 新会话只问两件事：在哪个项目里、用哪个模型。项目直接摊开选，模型通常不换，收在一行里。 */
export function NewSessionSheet({ bootstrap, client, close, created, error, t }: { bootstrap: Bootstrap; client: RemoteClient; close(): void; created(): void; error(cause: unknown): void; t: T }) {
	const theme = useTheme();
	const [projectId, setProjectId] = useState(bootstrap.projects[0]?.id ?? "scratch");
	const [modelId, setModelId] = useState(bootstrap.defaultModelId || bootstrap.models[0]?.id || "");
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const projects = [...bootstrap.projects.map((project) => ({ value: project.id, label: project.name, detail: project.path, mark: project.name })), { value: "scratch", label: t("scratch"), mark: "" }];
	const models = bootstrap.models.map((model) => ({ value: model.id, label: model.name, detail: model.provider }));
	const model = models.find((item) => item.value === modelId);
	return <Sheet title={t("newSession")} close={close} closeLabel={t("close")} tall footer={(dismiss) => <Button
		label={t("create")}
		icon="arrow-right"
		busy={busy}
		disabled={!model}
		onPress={() => { setBusy(true); void client.createSession(projectId, modelId).then(() => { dismiss(); created(); }).catch(error).finally(() => setBusy(false)); }}
	/>}>
		<ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
			<Eyebrow>{t("project")}</Eyebrow>
			<ChoiceList options={projects} value={projectId} choose={setProjectId} />
			<Eyebrow style={{ marginTop: 14 }}>{t("model")}</Eyebrow>
			{model ? <Group style={{ backgroundColor: theme.card }}>
				<GroupRow first label={model.label} detail={model.detail} onPress={() => setPicking(true)} />
			</Group> : <View style={{ padding: 16, borderRadius: 20, backgroundColor: theme.dangerSoft }}><Txt kind="sub" tone="danger">{t("noModels")}</Txt></View>}
		</ScrollView>
		{picking && <ChoiceSheet title={t("model")} options={models} value={modelId} choose={setModelId} close={() => setPicking(false)} t={t} />}
	</Sheet>;
}
