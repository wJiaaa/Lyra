/**
 * 打开一块屏的计划面板——审批卡上的「打开计划」，和计划交上来时替人打开的那一下。
 *
 * 由 dock 注册，理由同 `file-opener.ts`：审批卡长在对话里，dock 画着对话，从对话引 dock 会连成环。
 */

let planOpener: ((screen?: string) => void) | null = null;

export function providePlanOpener(open: typeof planOpener): void {
	planOpener = open;
}

export function openPlanInScreen(screen?: string): void {
	planOpener?.(screen);
}
