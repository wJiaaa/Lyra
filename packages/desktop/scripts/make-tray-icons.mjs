/**
 * Status bar icons, generated from the compact P in the Plume wordmark.
 * Colour is applied per platform:
 *
 *   - macOS gets a template image. The system ignores its RGB entirely and fills the alpha with
 *     the current menu bar's foreground colour, which is the only way to be correct in light
 *     mode, dark mode, and while a menu is pulled down over it.
 *   - Windows and Linux have no template equivalent, so they get the coloured mark.
 *
 * Run with `pnpm tray:icons`. The output is committed, because these are assets rather than build
 * products — nothing at build or run time should depend on being able to regenerate them.
 *
 * PNG handling stays local rather than adding an image dependency for one manual script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const trayDir = join(dirname(here), "build", "tray");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode to `{width, height, pixels}` with pixels as RGBA bytes. */
function decode(buffer) {
	if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let colourType = 0;
	let depth = 0;
	const parts = [];

	for (let at = 8; at < buffer.length; ) {
		const length = buffer.readUInt32BE(at);
		const type = buffer.toString("ascii", at + 4, at + 8);
		const data = buffer.subarray(at + 8, at + 8 + length);
		at += 12 + length;

		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			depth = data[8];
			colourType = data[9];
			if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
		} else if (type === "IDAT") parts.push(data);
		else if (type === "IEND") break;
	}

	if (depth !== 8 || colourType !== 6) throw new Error(`expected 8-bit RGBA, got depth ${depth} type ${colourType}`);

	const raw = inflateSync(Buffer.concat(parts));
	const stride = width * 4;
	const pixels = Buffer.alloc(height * stride);
	let read = 0;

	// Undo the per-scanline filters. Each is defined against the pixel to the left (a), the one
	// above (b) and the one above-left (c) — all zero outside the image.
	for (let y = 0; y < height; y++) {
		const filter = raw[read++];
		const line = raw.subarray(read, read + stride);
		read += stride;
		const out = pixels.subarray(y * stride, (y + 1) * stride);
		const above = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

		for (let x = 0; x < stride; x++) {
			const a = x >= 4 ? out[x - 4] : 0;
			const b = above ? above[x] : 0;
			const c = above && x >= 4 ? above[x - 4] : 0;
			let value = line[x];
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			out[x] = value & 0xff;
		}
	}

	return { width, height, pixels };
}

function encode({ width, height, pixels }) {
	const stride = width * 4;
	// Filter 0 throughout: these are tiny, and deflate does the work that matters.
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crcInput = Buffer.concat([head.subarray(4), data]);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc32(crcInput) >>> 0, 0);
		return Buffer.concat([head, data, tail]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;

	return Buffer.concat([
		PNG_MAGIC,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Box-filter downscale, averaging in premultiplied alpha.
 *
 * Averaging straight RGBA would let the colour of fully transparent pixels bleed into the edges —
 * the classic dark halo around a scaled-down cutout. It matters less here, where the colour is
 * about to be replaced wholesale, but the alpha edge itself has to be right: that edge is the
 * entire icon.
 */
function resize(image, height) {
	// Height is the shared measure; width follows the artwork so nothing is squashed.
	const width = Math.max(1, Math.round((image.width * height) / image.height));
	const out = Buffer.alloc(width * height * 4);
	const scaleX = image.width / width;
	const scaleY = image.height / height;

	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * scaleY);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * scaleX);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;

			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * image.width + sx) * 4;
					const alpha = image.pixels[i + 3] / 255;
					r += image.pixels[i] * alpha;
					g += image.pixels[i + 1] * alpha;
					b += image.pixels[i + 2] * alpha;
					a += image.pixels[i + 3];
					n++;
				}
			}

			const o = (y * width + x) * 4;
			const alpha = a / n;
			// Back out of premultiplied, guarding the fully transparent case.
			const unpremultiply = alpha === 0 ? 0 : 255 / alpha;
			out[o] = Math.min(255, Math.round((r / n) * unpremultiply));
			out[o + 1] = Math.min(255, Math.round((g / n) * unpremultiply));
			out[o + 2] = Math.min(255, Math.round((b / n) * unpremultiply));
			out[o + 3] = Math.round(alpha);
		}
	}

	return { width, height, pixels: out };
}

/**
 * Clear the haze off the alpha before anything is scaled.
 *
 * Drop faint edge pixels before reducing the mark to menu bar size, while keeping antialiasing.
 */
function harden(image, floor = 16, gamma = 0.85) {
	const pixels = Buffer.from(image.pixels);
	for (let i = 3; i < pixels.length; i += 4) {
		const alpha = pixels[i];
		pixels[i] = alpha < floor ? 0 : Math.round(255 * (alpha / 255) ** gamma);
	}
	return { ...image, pixels };
}

/** Keep the alpha, replace every colour. The silhouette is the icon; the colour is per-platform. */
function paint(image, [r, g, b]) {
	const pixels = Buffer.from(image.pixels);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = r;
		pixels[i + 1] = g;
		pixels[i + 2] = b;
	}
	return { ...image, pixels };
}

/**
 * Crop to the glyph, and no further.
 *
 * A menu bar lines its icons up by height, so height is what has to match — pad this back to a
 * square and a wide subject gains transparent margin above and below, renders shorter than
 * everything beside it, and reads as the small blurry one in the row. Cropping tight and scaling
 * by height is what makes it sit at the same size as its neighbours.
 */
function trim(image) {
	let top = image.height;
	let left = image.width;
	let right = -1;
	let bottom = -1;

	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if (image.pixels[(y * image.width + x) * 4 + 3] < 8) continue;
			if (y < top) top = y;
			if (y > bottom) bottom = y;
			if (x < left) left = x;
			if (x > right) right = x;
		}
	}

	if (right < left || bottom < top) return image;

	const width = right - left + 1;
	const height = bottom - top + 1;
	const pixels = Buffer.alloc(width * height * 4);

	for (let y = 0; y < height; y++) {
		const from = ((top + y) * image.width + left) * 4;
		image.pixels.copy(pixels, y * width * 4, from, from + width * 4);
	}

	return { width, height, pixels };
}

const BLACK = [0, 0, 0];

/**
 * Two treatments, because the two platforms want opposite things from a status bar icon.
 *
 * macOS wants a *shape*. Its menu bar icons are one colour filled by the system, so anything with
 * its own palette is wrong there by construction — it would not invert with the bar. So the mac
 * source is the outlined letter and feather, and the colour is whatever the system says.
 *
 * Windows has no template equivalent and its notification area is full of colour — the network
 * icon, the volume icon, every third-party app. A flat monochrome shape there is the odd one out,
 * and on top of that the taskbar can be light or dark. So Windows gets the coloured P as drawn.
 */
const artwork = decode(readFileSync(join(here, "../../../assets/plume-tray-mark.png")));
const macSource = trim(harden(artwork));
const winSource = trim(artwork);

/*
 * 18pt on macOS, 16px on Windows.
 *
 * Apple's menu bar is 24pt and its own items are drawn at 18 — matching that is what makes this
 * sit at the same size as everything beside it. Windows' notification area is a 16px grid.
 *
 * The extra Windows sizes are not padding: 125% and 150% are the two commonest display scalings on
 * Windows laptops, and without a bitmap made *at* 20 and 24 the system resamples the 16 or the 32
 * to get there. That resample is the difference between an icon with clean edges and one that
 * looks slightly out of focus — which on a 20-pixel drawing is most of what anybody sees of it.
 * Electron picks these up from the `@1.25x`/`@1.5x` suffix automatically.
 */
const outputs = [
	["trayTemplate.png", 18, macSource, BLACK],
	["trayTemplate@2x.png", 36, macSource, BLACK],
	["tray.png", 16, winSource, null],
	["tray@1.25x.png", 20, winSource, null],
	["tray@1.5x.png", 24, winSource, null],
	["tray@2x.png", 32, winSource, null],
];

for (const [name, height, source, colour] of outputs) {
	const scaled = resize(source, height);
	const image = colour ? paint(scaled, colour) : scaled;
	writeFileSync(join(trayDir, name), encode(image));
	console.log(`[tray] ${name} — ${image.width}×${image.height}`);
}
