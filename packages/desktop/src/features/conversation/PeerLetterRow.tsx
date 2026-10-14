/**
 * 另一个会话发来的消息——对话里的一行，不是人发的气泡。
 *
 * 那条消息是写给模型的：正文外面套着 `<session-message>` 和一段「这不是用户说的话」的说明。
 * 原样画在人那一侧，读的人会看见一大段自己没说过的话；什么都不画，这个会话又像是自己突然动了
 * 起来。所以画成过程行：谁写来的、开头一句，点开读全文，旁边一下跳到那个会话。
 *
 * 跳转放在这一行上，不放在展开的正文底下：要去那个会话的人不必先把整封信读完才找得到入口。
 */

import { useState, type ReactNode } from "react";
import type { PeerLetter } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { ArrowUpRight, MessagesSquare } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useApp } from "../../store/index.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { jumpToSession } from "./jump-to-session.ts";

/** 地址里的名字：`修登录 [a1b2c3]` 画成「修登录」，ref 是给模型认人的。 */
function nameOf(address: string): string {
	return address.replace(/\s*\[[0-9a-f]{6,12}\]$/i, "") || address;
}

/** 正文怎么排版由行那一层给：`Markdown` 在这里直接引会连成一个环（见 `.dependency-cruiser.cjs`）。 */
export function PeerLetterRow({ letters, renderText }: { letters: PeerLetter[]; renderText: (text: string) => ReactNode }) {
	return (
		<div className="my-1" data-peer-row="">
			{letters.map((letter, index) => <Letter key={index} letter={letter} renderText={renderText} />)}
		</div>
	);
}

function Letter({ letter, renderText }: { letter: PeerLetter; renderText: (text: string) => ReactNode }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const sessionId = useScopedSessionId();
	const jump = () => {
		if (!jumpToSession(sessionId, letter.sessionId)) useApp.getState().notify(t("peers.sessionGone"), "warn");
	};
	const text = letter.text;
	return (
		<div data-peer-letter="">
			<div className="flex min-w-0 items-center gap-1">
				<FlowRow
					icon={<MessagesSquare size={13} strokeWidth={1.8} />}
					/* 别的过程行标题是「思考」这种两三个字的词，加粗读作标签；这里装的是会话名，整段加粗就成了一行粗字。 */
					title={<span className="font-normal">{t("peers.from", { name: nameOf(letter.from) })}</span>}
					summary={text.split("\n").find((line) => line.trim()) ?? ""}
					open={open}
					onToggle={() => setOpen((value) => !value)}
					label={t("peers.letter")}
					data-ly-tip={letter.from}
				/>
				<IconButton size="xs" icon={<ArrowUpRight size={12} strokeWidth={1.8} />} label={t("peers.open")} onClick={jump} tipSide="top" data-peer-open="" />
			</div>
			<Collapse open={open} bodyClassName="mt-1.5 border-l-2 border-line pl-3">
				{renderText(text)}
			</Collapse>
		</div>
	);
}
