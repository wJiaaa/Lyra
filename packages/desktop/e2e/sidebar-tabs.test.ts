/**
 * The sidebar's list, pinned for real.
 *
 * Everything here measures boxes and reads computed style. Nothing asserts on a class name, and
 * nothing reads the store — the claim under test is "the project name stays at the top and the
 * list goes under it", and the only honest evidence for that is where things are and how much of
 * them is being drawn.
 *
 * The rows are held by `position: sticky`, so where they sit is the browser's job and not worth
 * asserting. What is worth asserting is everything around it: that the fade starts under them
 * rather than through them, that they cover what passes under them, and — the
 * one that cost the most to learn — that a pinned row does not move while the list scrolls under
 * it. An earlier version placed these by hand from `scroll` events and lagged the compositor by a
 * frame, which is a row visibly jumping a wheel tick at a time.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";

let app: RunningApp;

const DAY = 86_400_000;
/**
 * Enough projects that the list runs several screens past the viewport.
 *
 * Length is load-bearing here rather than incidental. A list that only just overflows cannot be
 * scrolled far enough for a heading to reach the rail and be held there — every scroll lands in the
 * middle of one heading pushing out the next — and it bottoms out immediately, which takes the
 * lower fade with it. Both of those read as the feature being broken.
 */
const PROJECTS = [
	"alpha-project",
	"beta-project",
	"gamma-project",
	"delta-project",
	"epsilon-project",
	"zeta-project",
	"eta-project",
	"theta-project",
];
const PER_PROJECT = 9;

before(async () => {
	app = await startApp({ port: 9730, seed });
	// Geometry, so the window has to be a known quantity rather than whatever this machine opens at.
	await app.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await new Promise((r) => setTimeout(r, 800));
});

after(async () => {
	await app?.stop();
});

async function seed(home: string): Promise<void> {
	const now = Date.now();
	const ages = [0, 0, 1, 1, 3, 9, 20, 40, 90];
	const metas = [];
	let n = 0;
	for (const name of PROJECTS) {
		for (let i = 0; i < PER_PROJECT; i++) {
			const updatedAt = now - ages[i % ages.length] * DAY - n * 60_000;
			metas.push({
				id: `s${n}`,
				title: `${name} 会话 ${i + 1}`,
				cwd: `/w/${name}`,
				projectId: name,
				projectName: name,
				createdAt: updatedAt - 60_000,
				updatedAt,
				modelId: "m",
				messageCount: 4,
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				seq: 1,
				// A third filed away, so the archive is long enough to scroll and pin too.
				archived: n % 3 === 2,
			});
			n++;
		}
	}

	seedSessions(home, metas.map((meta) => ({ meta, records: [] })));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: PROJECTS.map((name, i) => ({ path: `/w/${name}`, name, pinned: false, lastOpenedAt: 100 - i })),
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			pluginRegistries: [],
			skillRegistries: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
}

const VIEW = `document.querySelector(".ly-sidebar-fill .ly-scroll-view")`;

interface Pinned {
	/** Distance from the top of the scroll viewport, in CSS pixels. */
	y: number;
	height: number;
	text: string;
	/** How much of it is being drawn. A held heading is drawn in full and covers what passes under it. */
	opacity: number;
	/**
	 * What it is painting, as `[r, g, b, a]` off a canvas rather than as a string.
	 *
	 * Computed colours come back in whichever notation the declaration used — `rgb()`, `rgba()`,
	 * `color(srgb …)` from a `color-mix()` — and comparing those as text means adding a case every
	 * time a stylesheet changes how it spells one. Painting the colour and reading the pixel gives
	 * one form for all of them — compared against `pane`, the colour the sidebar is painted with.
	 */
	fill: [number, number, number, number];
}

interface State {
	scrollTop: number;
	/** Where the unsoftened band starts. Non-zero only while a row is on its way to its rail. */
	holdTop: number;
	/** How deep the mask is erasing the list — what the pinned rows are standing on. */
	inset: number;
	fadeTop: number;
	fadeBottom: number;
	/** Where the list begins in the scroller — below the destinations when they are in it. */
	listInList: number;
	heads: Pinned[];
	/** Every conversation row in the list. */
	rows: { y: number; height: number; opacity: number }[];
	/** The offset headings come to rest at, as the stylesheet has it. */
	rail: number;
	/** What the sidebar is painted with: the nav column's shade, or the drawer's own fill. */
	pane: [number, number, number, number];
}

/** Everything the pane is doing right now, read off the elements the user is looking at. */
async function state(): Promise<State> {
	return app.evaluate<State>(`(() => {
		const view = ${VIEW};
		const origin = view.getBoundingClientRect().top;
		const clean = (el) => el.innerText.replace(/\\s+/g, " ").trim();
		// Paint the colour and read the pixel: one form for every notation a computed style uses.
		const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		const rgba = (css) => {
			paint.clearRect(0, 0, 1, 1);
			paint.fillStyle = css.trim();
			paint.fillRect(0, 0, 1, 1);
			return [...paint.getImageData(0, 0, 1, 1).data];
		};
		const pin = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return {
				y: r.top - origin,
				height: r.height,
				text: clean(el),
				opacity: Number(getComputedStyle(el).opacity),
				fill: rgba(getComputedStyle(el).backgroundColor),
			};
		};
		const style = getComputedStyle(view);
		const px = (name) => Number.parseFloat(style.getPropertyValue(name)) || 0;
		return {
			scrollTop: view.scrollTop,
			holdTop: px("--ly-hold-top"),
			inset: px("--ly-fade-inset"),
			fadeTop: px("--ly-fade-top"),
			fadeBottom: px("--ly-fade-bottom"),
			listInList: view.querySelector("[data-ly-list]").getBoundingClientRect().top - origin,
			heads: [...view.querySelectorAll("[data-ly-head]")].map(pin),
			rows: [...view.querySelectorAll("[data-ly-row]")].map((el) => {
				const r = el.getBoundingClientRect();
				return { y: r.top - origin, height: r.height, opacity: Number(getComputedStyle(el).opacity) };
			}),
			rail: Number.parseFloat(getComputedStyle(view).getPropertyValue("--ly-rail")) || 0,
			pane: rgba(getComputedStyle(view.closest(".ly-nav-column") ?? view.closest(".ly-sidebar-fill")).backgroundColor),
		};
	})()`);
}

async function scrollTo(y: number): Promise<State> {
	await app.evaluate(`(() => { ${VIEW}.scrollTop = ${y}; return true; })()`);
	// The placement runs on the next frame and the fades ease over `--ly-t-base`; this is past both,
	// so every number read here is the settled one rather than a value mid-transition.
	await new Promise((r) => setTimeout(r, 260));
	return state();
}

/**
 * Scroll until a heading is actually being held back, and report where it ended up.
 *
 * Hunting for it rather than scrolling to a number that ought to work. Between one heading being
 * held and the next taking over there is a stretch where nothing is at rest, and which offsets fall
 * in it depends on how many conversations each project happens to have — so picking a constant
 * means writing the fixture's row heights into the test twice.
 *
 * Held means resting exactly on the rail the stylesheet gives it — read from the page rather than
 * recomputed here, so this checks the browser is holding the row where the design says, not that
 * two copies of the same arithmetic agree.
 */
async function scrollUntilPinned(from = 200, to = 2200, step = 40, notThisOne?: string) {
	for (let y = from; y <= to; y += step) {
		const at = await scrollTo(y);
		const held = at.heads.find((head) => head.text !== notThisOne && Math.abs(head.y - at.rail) < 1);
		if (held) return { at, held };
	}
	return null;
}

/** Click a control by its accessible name, anywhere in the sidebar. */
async function click(label: string): Promise<void> {
	const hit = await app.evaluate<boolean>(`(() => {
		const el = [...document.querySelectorAll(".ly-sidebar-fill button")]
			.find((b) => (b.getAttribute("aria-label") ?? "").includes(${JSON.stringify(label)}));
		if (!el) return false;
		el.click();
		return true;
	})()`);
	assert.ok(hit, `no control named ${label}`);
	await new Promise((r) => setTimeout(r, 500));
}

/**
 * Whether the window has its icon rail, which is where 拉取请求, 已安排 and 插件 go when it does
 * (ADR-0038). Then nothing is above the list in the scroller. A window too narrow for the rail
 * puts them back in it, above the list.
 */
const destinationsOnRail = () => app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-app-rail]"))`);

test("at rest nothing is erased", async () => {
	const at = await scrollTo(0);
	if (!(await destinationsOnRail())) assert.ok(at.listInList > 60, `the list sits below the destinations: ${JSON.stringify(at)}`);
	assert.equal(at.fadeTop, 0, "nothing is hidden above, so nothing softens");
	for (const row of at.rows.filter((r) => r.y < 800)) {
		assert.ok(row.opacity > 0.99, `a row at ${row.y.toFixed(1)} is drawn in full at rest (${row.opacity})`);
	}
});

test("a project name is held at the top, and the list is erased out from under it", async () => {
	const found = await scrollUntilPinned();
	assert.ok(found, "some scroll position holds a heading at the rail");
	assert.ok(found.held.text.length > 0, "and it is a real heading with a name on it");
	/*
	 * The erased band, not the heading's fill. If the band stopped short of it, the rows below
	 * would start softening while still under the project name — the first conversation in a
	 * project, half drawn, every time.
	 */
	assert.ok(
		found.at.inset >= found.held.y + found.held.height - 1,
		`the erased band reaches the heading's underside (inset ${found.at.inset}, needs ${found.held.y + found.held.height})`,
	);
});

/*
 * The headings paint the sidebar's own colour, held or not.
 *
 * The pane is opaque in both of its forms — the nav column's shade beside the content, the drawer's
 * fill over it — so a heading that paints the same colour covers whatever passes under it and is
 * invisible as a block at rest. A different shade would show as a band; no fill at all lets the
 * rows show through. `misc.css` has why the list no longer fades itself out instead.
 */
test("the headings paint the pane's colour, held or not", async () => {
	const rest = await scrollTo(0);
	for (const head of rest.heads) assert.deepEqual(head.fill, rest.pane, `「${head.text}」 at rest`);

	const found = await scrollUntilPinned();
	assert.ok(found, "some scroll position holds a heading at the rail");
	assert.deepEqual(found.held.fill, found.at.pane, `「${found.held.text}」 held`);
	assert.ok(found.held.opacity > 0.99, `「${found.held.text}」 held is drawn in full (${found.held.opacity})`);
});

/*
 * Which means a row passing under a held heading is covered by it, not drawn through it.
 *
 * Asked of the page directly: at a point where a row and a held heading overlap, the topmost thing
 * is the heading. Rows themselves are never faded for it — the one under the heading stays whole.
 */
test("nothing in the list shows through a held row", async () => {
	let overlaps = 0;
	for (let y = 200; y <= 2200; y += 40) {
		await scrollTo(y);
		const found = await app.evaluate<{ overlaps: number; through: string[]; faded: string[] }>(`(() => {
			const view = ${VIEW};
			const origin = view.getBoundingClientRect().top;
			const through = [];
			const faded = [];
			let overlaps = 0;
			for (const head of view.querySelectorAll("[data-ly-head]")) {
				const box = head.getBoundingClientRect();
				if (box.top - origin > 1 || box.bottom <= origin) continue;
				for (const row of view.querySelectorAll("[data-ly-row]")) {
					const own = row.getBoundingClientRect();
					const top = Math.max(own.top, box.top, origin);
					const bottom = Math.min(own.bottom, box.bottom);
					if (Number(getComputedStyle(row).opacity) < 0.99 && own.bottom > origin) faded.push(row.innerText.trim().slice(0, 16));
					if (bottom - top <= 2) continue;
					overlaps++;
					const hit = document.elementFromPoint(own.left + own.width / 2, (top + bottom) / 2);
					if (!head.contains(hit)) through.push(row.innerText.trim().slice(0, 16));
				}
			}
			return { overlaps, through, faded };
		})()`);
		overlaps += found.overlaps;
		assert.deepEqual(found.through, [], `at ${y}px a row shows through a held heading`);
		assert.deepEqual(found.faded, [], `at ${y}px a row is faded rather than covered`);
	}
	assert.ok(overlaps > 0, "some scroll position has a row passing under a held heading");
});

/*
 * A heading on its way out is pushed up by the end of its own project, so the next one arrives
 * below it rather than on top of it — two names never share the top edge.
 */
test("a heading being pushed out is not overlapped by the next one", async () => {
	let seen = 0;
	for (let y = 200; y <= 2200; y += 6) {
		const at = await scrollTo(y);
		const leaving = at.heads.filter((h) => h.y < at.rail - 1 && h.y + h.height > 0);
		for (const head of leaving) {
			seen++;
			const next = at.heads.find((h) => h.y > head.y);
			if (next) assert.ok(next.y >= head.y + head.height - 0.5, `「${next.text}」 at ${next.y.toFixed(1)} overlaps 「${head.text}」 ending at ${(head.y + head.height).toFixed(1)}`);
		}
		if (seen >= 3) break;
	}
	assert.ok(seen > 0, "some scroll position catches a heading on its way out");
});

test("landed, the band starts at the top edge", async () => {
	const found = await scrollUntilPinned();
	assert.ok(found, "a heading is held");
	assert.equal(found.at.holdTop, 0, "nothing above it to leave unsoftened, so the band starts at the edge");
});

test("scrolling on past a project hands the rail to the next one", async () => {
	const first = await scrollUntilPinned();
	assert.ok(first, "a heading is held to begin with");

	// Carry on from where that one was found until a *different* project has taken the rail. How
	// far that is depends on how tall the first project's block happens to be, so it is searched
	// for rather than guessed at.
	const later = await scrollUntilPinned(first.at.scrollTop + 40, 2600, 40, first.held.text);
	assert.ok(later, "something is still held further down");
	assert.notEqual(later.held.text, first.held.text, "and it is a different project than the one we started in");
	assert.ok(
		later.at.inset >= later.held.y + later.held.height - 1,
		"with the band still erased to its underside",
	);
});

/*
 * The one that cost the most to learn, and the reason the pinning is CSS.
 *
 * Setting `scrollTop` from a test proves nothing here: that runs on the main thread, so a
 * measurement taken beside it lands in the same frame by construction and the failure cannot
 * appear. A wheel is handled on the compositor — the list moves there — so anything positioned from
 * JavaScript is drawn where the list *was*. The first version of this feature did exactly that and
 * every pinned row wobbled by a wheel tick: measured at 14px.
 *
 * Pinned means "does not move". Once held, its offset is a constant, and this is the whole claim.
 */
test("a pinned row does not move while a real wheel scrolls the list under it", async () => {
	const found = await scrollUntilPinned();
	assert.ok(found, "a heading is held");
	await app.evaluate(`(() => {
		const view = ${VIEW};
		const held = [...view.querySelectorAll("[data-ly-head]")].find((el) => el.innerText.replace(/\\s+/g, " ").trim() === ${JSON.stringify(found.held.text)});
		window.__wobble = { strip: [], scrolls: [], room: [] };
		let frames = 0;
		function step() {
			const origin = view.getBoundingClientRect().top;
			window.__wobble.strip.push(held.getBoundingClientRect().top - origin);
			// How far its project's block still reaches below it: under its own height, the next
			// heading is pushing it out, which is moving on purpose.
			window.__wobble.room.push(held.parentElement.getBoundingClientRect().bottom - held.getBoundingClientRect().bottom);
			window.__wobble.scrolls.push(view.scrollTop);
			if (++frames < 200) requestAnimationFrame(step);
		}
		requestAnimationFrame(step);
		return true;
	})()`);

	// Small steps in both directions, the way a trackpad sends them.
	for (let i = 0; i < 24; i++) {
		await app.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: 150,
			y: 500,
			deltaX: 0,
			deltaY: i < 12 ? 4 : -4,
			pointerType: "mouse",
		});
		await new Promise((r) => setTimeout(r, 16));
	}
	await new Promise((r) => setTimeout(r, 300));

	const trace = await app.evaluate<{ strip: number[]; scrolls: number[]; room: number[] }>("window.__wobble");
	const moving = trace.strip.filter(
		(_, i) => i > 0 && trace.scrolls[i] > 100 && trace.scrolls[i] !== trace.scrolls[i - 1] && trace.room[i] > 1,
	);
	assert.ok(moving.length > 10, `the wheel actually scrolled the list (${moving.length} moving frames)`);

	const wobble = Math.max(...moving) - Math.min(...moving);
	assert.ok(
		wobble < 1,
		`the held heading stayed put while the list moved under it — wobble ${wobble.toFixed(2)}px across ${moving.length} frames`,
	);
});

/*
 * 列表设置 lives on the 「项目」 heading beside 新建项目, and like it only shows on hover — the
 * count gives way to them. While its menu is open the pointer has gone to the menu, so the button
 * stays rather than vanishing from under the menu it anchors.
 */
test("列表设置 sits beside 新建项目 on 「项目」 and shows on hover", async () => {
	await scrollTo(0);
	const heading = `document.querySelector(".ly-sidebar-fill [data-ly-section='projects']").parentElement`;
	const read = () =>
		app.evaluate<{ labels: string[]; action: number; count: number }>(`(() => {
			const row = ${heading};
			const action = row.querySelector("[data-ly-section-action]");
			return {
				labels: [...action.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
				action: Number(getComputedStyle(action).opacity),
				count: Number(getComputedStyle(row.querySelector("[data-ly-section-count]")).opacity),
			};
		})()`);
	const move = async (x: number, y: number) => {
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await new Promise((r) => setTimeout(r, 400));
	};

	await move(900, 600);
	const rest = await read();
	assert.deepEqual(rest.labels, ["列表设置", "新建项目"], "both controls are on the heading, list settings first");
	assert.ok(rest.action < 0.01 && rest.count > 0.99, `at rest only the count shows: ${JSON.stringify(rest)}`);

	const centre = await app.evaluate<{ x: number; y: number }>(`(() => { const r = ${heading}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await move(centre.x, centre.y);
	const hover = await read();
	assert.ok(hover.action > 0.99 && hover.count < 0.01, `hovered, the controls take the count's place: ${JSON.stringify(hover)}`);

	await click("列表设置");
	assert.ok(await app.evaluate<boolean>(`document.body.innerText.includes("排序方式")`), "the list settings menu opens");
	await move(900, 600);
	assert.ok((await read()).action > 0.99, "and the button stays while its menu is open");
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await new Promise((r) => setTimeout(r, 400));
	assert.ok((await read()).action < 0.01, "closed, it hides again");
});
