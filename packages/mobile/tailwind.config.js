/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
	presets: [require("nativewind/preset")],
	theme: {
		extend: {
			// Same tokens as the desktop app so the two surfaces read as one product.
			colors: {
				shell: "#171717",
				sidebar: "#1c1c1c",
				panel: "#202020",
				card: "#242424",
				"card-hover": "#2a2a2a",
				input: "#1f1f1f",
				elevated: "#2c2c2c",
				line: "#2e2e2e",
				"line-soft": "#262626",
				ink: "#ededed",
				"ink-muted": "#9a9a9a",
				"ink-faint": "#6e6e6e",
				accent: "#ff8b3d",
				ok: "#3ecf8e",
				info: "#5aa2f5",
				violet: "#b18cf5",
				danger: "#f2555a",
			},
		},
	},
	plugins: [],
};
