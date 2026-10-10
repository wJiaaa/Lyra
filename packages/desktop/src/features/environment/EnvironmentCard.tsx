/**
 * 环境卡片：这个会话「周边」的东西收在一处——用什么打开、跑着的后台任务、派出去的子 Agent、当前分支的 PR、
 * 侧边聊天、摘要、引用。每一行都只是入口，点了去已有的面板、弹窗或那一页。
 *
 * 照 Synara 的 Environment 面板做。项目、分支、改了多少、提交，Synara 也放在里面，这里没有：它们
 * 已经常驻在输入框上方那条栏里，再放一遍就是同一件事说两遍。
 *
 * 只在有内容时出现的节（后台任务、子 Agent、PR、侧边聊天、摘要、引用）空着就不画；节与节之间那条线由这里
 * 统一画在「后一节的上沿」，于是哪一节缺席都不会留下两条挨着的线。右上角那颗按钮逐节开关。
 */

import { Settings2 } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/messages/index.ts";
import { useScopedSessionId, useScopedWorkspace } from "../../app/session-scope.tsx";
import { ENVIRONMENT_SECTIONS, setEnvironmentSectionShown, useEnvironmentCard, type EnvironmentSection } from "../../store/environment-card.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { MenuBody, MenuItem, MenuLabel, Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { JobsSection } from "./JobsSection.tsx";
import { OpenInSection } from "./OpenInSection.tsx";
import { PullRequestSection } from "./PullRequestSection.tsx";
import { ReferencesSection } from "./ReferencesSection.tsx";
import { SideChatsSection } from "./SideChatsSection.tsx";
import { SubAgentsSection } from "./SubAgentsSection.tsx";
import { SummarySection } from "./SummarySection.tsx";

const SECTION_LABEL: Record<EnvironmentSection, MessageKey> = {
	openIn: "environment.sectionOpenIn",
	jobs: "services.title",
	subAgents: "subAgent.title",
	pullRequest: "environment.sectionPullRequest",
	sideChats: "dock.sideChat",
	summary: "environment.summary",
	references: "environment.references",
};

export function EnvironmentCard() {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const { workspace } = useScopedWorkspace();
	const hidden = useEnvironmentCard((state) => state.hidden);
	const menu = usePopover();
	const shown = (section: EnvironmentSection) => !hidden.includes(section);

	return (
		<div
			data-ly-environment
			className="ly-glass pointer-events-auto flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-[11px] border border-line-soft shadow-lg shadow-black/[0.06]"
		>
			<div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
				<span className="min-w-0 flex-1 truncate text-label text-ink-muted">{t("environment.title")}</span>
				<IconButton size="sm" label={t("environment.sections")} icon={<Settings2 size={13} />} onClick={menu.toggle} active={menu.open} />
			</div>
			<div className="min-h-0 overflow-y-auto px-1.5 pb-1 [&>*+*]:border-t [&>*+*]:border-line-soft">
				{shown("openIn") && <OpenInSection />}
				{sessionId && shown("jobs") && <JobsSection sessionId={sessionId} />}
				{shown("subAgents") && <SubAgentsSection />}
				{shown("pullRequest") && workspace?.isGitRepo && <PullRequestSection path={workspace.path} branch={workspace.branch ?? null} />}
				{sessionId && shown("sideChats") && <SideChatsSection sessionId={sessionId} />}
				{sessionId && shown("summary") && <SummarySection sessionId={sessionId} />}
				{sessionId && shown("references") && <ReferencesSection sessionId={sessionId} />}
			</div>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default">
					<MenuBody>
						<MenuLabel>{t("environment.sections")}</MenuLabel>
						{ENVIRONMENT_SECTIONS.map((section) => (
							<MenuItem key={section} checked={shown(section)} onClick={() => setEnvironmentSectionShown(section, !shown(section))}>
								{t(SECTION_LABEL[section])}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}
