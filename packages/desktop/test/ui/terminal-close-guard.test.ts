/**
 * 关掉正跑着程序的终端之前先问一句；停在提示符上的照旧一点就关。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmCloseTerminal, showing, useCloseQuestion } from "../../src/features/terminal/close-guard.ts";
import { useTerminals } from "../../src/store/terminals.ts";

function seed(process: string | null) {
	useTerminals.setState({ tabs: [{ id: "t1", title: "终端 1", process }], active: "", activeByScope: { "@draft": "t1" } });
}

test("a terminal at its prompt closes without a question", async () => {
	seed(null);
	const stop = showing("t1");
	try {
		assert.equal(await confirmCloseTerminal("@draft", "terminal"), true);
		assert.equal(useCloseQuestion.getState().asking, null);
	} finally {
		stop();
	}
});

test("a terminal running something asks, and keeps it unless the answer is to close", async () => {
	seed("node");
	const stop = showing("t1");
	try {
		const kept = confirmCloseTerminal("@draft", "terminal");
		assert.equal(useCloseQuestion.getState().asking?.process, "node");
		useCloseQuestion.getState().asking?.answer(false);
		assert.equal(await kept, false);
		assert.equal(useCloseQuestion.getState().asking, null);

		const closed = confirmCloseTerminal("@draft", "terminal");
		useCloseQuestion.getState().asking?.answer(true);
		assert.equal(await closed, true);
	} finally {
		stop();
	}
});

test("with no pane here to ask in, it closes as it always did rather than hanging", async () => {
	seed("node");
	assert.equal(await confirmCloseTerminal("@draft", "terminal"), true);
});

test("the process the tab shows follows what the main process reports", () => {
	seed(null);
	useTerminals.getState().setProcess("t1", "vim");
	assert.equal(useTerminals.getState().tabs[0]?.process, "vim");
	useTerminals.getState().setProcess("t1", null);
	assert.equal(useTerminals.getState().tabs[0]?.process, null);
});
