/**
 * The icon a bundle ships, read off a real directory.
 *
 * The same rules the platform applies to the archive it built — that is the point of them living in
 * `@plume/registry-shared` — so what is tested here is that this side reaches the same answers from
 * files rather than from tar members, including the refusals. An icon that is refused costs the
 * icon and nothing else: the bundle still installs, still loads, and still gets the mark for its
 * kind.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readBundleIcon } from "../src/plugins/bundle-icon.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function bundle(files: Record<string, string | Buffer>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-icon-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, content);
	}
	return dir;
}

test("an icon in our own directory is read as a data URL", async () => {
	const dir = await bundle({ ".lyra-plugin/icon.svg": SVG });
	const icon = await readBundleIcon(dir);
	assert.ok(icon?.startsWith("data:image/svg+xml;base64,"), `got ${icon}`);
	assert.equal(Buffer.from(icon!.split(",")[1], "base64").toString(), SVG);
});

test("our directory wins over a picture at the root", async () => {
	/*
	 * A repository carrying both is one where the author put a picture *for us* in the place that
	 * says so; the root `logo.png` is as likely to be the README's banner.
	 */
	const dir = await bundle({ ".lyra-plugin/icon.svg": SVG, "logo.png": PNG });
	assert.match((await readBundleIcon(dir))!, /^data:image\/svg\+xml/);
});

test("a manifest may name the file, and naming the wrong one gets nothing", async () => {
	const dir = await bundle({ "art/mark.svg": SVG, ".lyra-plugin/icon.svg": SVG });
	assert.match((await readBundleIcon(dir, "art/mark.svg"))!, /^data:image\/svg\+xml/);

	/*
	 * Not a fallback to the guessed file, which is there and would load. A manifest that names an
	 * icon and gets it wrong is a different situation from one that names none, and serving a
	 * different picture than the one asked for is the worse answer to it.
	 */
	assert.equal(await readBundleIcon(dir, "art/missing.svg"), undefined);
});

test("a declared path that climbs out of the bundle is refused", async () => {
	// It finds nothing in a Map on the platform; here it would name a real file on the user's disk.
	const dir = await bundle({ ".lyra-plugin/icon.svg": SVG });
	assert.equal(await readBundleIcon(dir, "../../../.ssh/id_rsa"), undefined);
	assert.equal(await readBundleIcon(dir, "/etc/passwd"), undefined);
});

test("an SVG carrying script is not drawn", async () => {
	/*
	 * It becomes a `data:` URL in a renderer that can reach `window.plume`. Refused rather than
	 * sanitised: sanitising means keeping a list of everything dangerous and being right about all
	 * of it forever.
	 */
	for (const bad of [
		'<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//x")</script></svg>',
		'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
		'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x/p.png"/></svg>',
	]) {
		const dir = await bundle({ ".lyra-plugin/icon.svg": bad });
		assert.equal(await readBundleIcon(dir), undefined, bad);
	}
});

test("bytes that do not match the extension are refused", async () => {
	// The extension is the only type information a file carries and whoever wrote it chose it.
	const dir = await bundle({ ".lyra-plugin/icon.png": "<html><body>not a png</body></html>" });
	assert.equal(await readBundleIcon(dir), undefined);
});

test("an icon too large to send on every scan is left on disk", async () => {
	/*
	 * This crosses the IPC boundary for every installed bundle on every scan, which is a different
	 * budget from the platform's — there an icon is fetched by whoever opens that one entry.
	 */
	const huge = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(200_000)}--></svg>`;
	const dir = await bundle({ ".lyra-plugin/icon.svg": huge });
	assert.equal(await readBundleIcon(dir), undefined);
});

test("a bundle that ships no picture says so by returning nothing", async () => {
	const dir = await bundle({ "README.md": "# hi" });
	assert.equal(await readBundleIcon(dir), undefined);
});

test("a declared remote URL does not stop the bundle's own icon from being found", async () => {
	/*
	 * The ordering the platform's icon route uses, restated on this side: the file in the bundle
	 * wins over a URL, because the URL depends on a server that may be gone. An app that preferred
	 * the URL would draw a different mark than the catalogue did, for the same bundle.
	 */
	const dir = await bundle({ ".lyra-plugin/icon.svg": SVG });
	assert.match((await readBundleIcon(dir, "https://example.com/mark.png"))!, /^data:image\/svg\+xml/);

	// And with no file to find, there is nothing to say — the caller keeps the URL it already had.
	const bare = await bundle({ "README.md": "# hi" });
	assert.equal(await readBundleIcon(bare, "https://example.com/mark.png"), undefined);
});
