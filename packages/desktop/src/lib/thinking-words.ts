/**
 * What to call the waiting, and what to draw while it lasts.
 *
 * A turn is mostly silence — a loader and a number counting up. The number says how long, the
 * loader says it is alive, and neither says what kind of waiting this is. Reading a file, running
 * a test and hunting through a codebase feel different to sit through, and naming the difference
 * is most of what makes a long turn bearable.
 *
 * Written here, not asked of the model. Making it produce a status line would cost a request per
 * phrase, arrive too late to describe what it is doing now, and put one more thing in the way of
 * the actual answer. These are picked from what the agent has just done, which the window already
 * knows.
 *
 * The tone is deliberately colloquial, and in English — it sits beside `42s · 63.6k tokens`, and
 * a Chinese phrase in that row read as a different voice interrupting a technical readout. This
 * is the app muttering to itself in the corner of the screen, not a progress dialog reporting to
 * a manager.
 *
 * One classification, two consumers. The words below and the orb beside them are the same answer
 * drawn twice, so `Mood` *is* `OrbState` rather than a parallel vocabulary that has to be kept in
 * step by hand — a mood the orb cannot draw stops compiling, and an orb state nothing ever picks
 * is a missing key in `WORDS`.
 */

import type { OrbState } from "thinking-orbs";
import { moodFor as classify, phraseFor as phrase } from "@plume/client-runtime/running";

/*
 * 词表和选词规则在 `@plume/client-runtime/running`：手机消息流末尾那一行和这里说同一套话，两份
 * 各写一份迟早分叉。这里只做一件那边做不了的事——client-runtime 不能依赖画布库，于是「每种 mood
 * 都是小球能画的状态」在这里检查：
 *
 * - `moodFor` 标成返回 `OrbState`：那边多出一种小球画不了的 mood，这一行编译不过。
 * - `phraseFor` 标成接受 `OrbState`：小球多出一种状态而词表里没有，这一行编译不过。
 */
export type Mood = OrbState;
export const moodFor: (toolName: string | undefined, summary: string | undefined, retrying?: boolean, writing?: boolean) => Mood = classify;
export const phraseFor: (mood: Mood, tick: number, elapsedMs: number) => string = phrase;
