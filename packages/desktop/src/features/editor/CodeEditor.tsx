import { defaultKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

import { useApp } from "../../store/index.ts";
import { GRAMMARS, grammarKeyFor, highlightStyle } from "../../lib/code/highlight.ts";
import { editorTheme } from "./theme.ts";
import { labelSearchPanel, searchPhrases } from "./chrome.ts";
import { EditorMenu } from "./EditorMenu.tsx";
import { useContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { OverlayScrollbar } from "../../ui/scroll/OverlayScrollbar.tsx";

/**
 * 只读的代码预览。
 *
 * 用 CodeMirror 而不是一个上了色的 `<pre>`：行号、折叠、括号配对、⌘F 查找和跳到行，读长文件时
 * 都用得上。改文件交给 Agent 或者外部编辑器，这里不提供编辑、保存和格式化。
 *
 * Languages load on demand. Bundling twenty grammars for the one file you opened would put
 * megabytes into the initial payload to support a panel that is usually closed.
 */
export function CodeEditor({
	path,
	text,
	wrap,
}: {
	/** Identity of the document; changing it rebuilds the state. */
	path: string;
	text: string;
	/** Soft-wrap long lines instead of scrolling sideways. */
	wrap?: boolean;
}) {
	const host = useRef<HTMLDivElement>(null);
	/*
	 * CodeMirror's scrolling element, which only exists once the view is built.
	 *
	 * State rather than a ref, because the thumbs have to render again once it appears — a ref
	 * assigned inside the mount effect would leave them measuring nothing on the first pass.
	 */
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const scrollerRef = useRef<HTMLElement | null>(null);
	scrollerRef.current = scroller;
	const view = useRef<EditorView | null>(null);
	const language = useRef(new Compartment());
	/*
	 * Wrapping is reconfigured, not rebuilt.
	 *
	 * Putting `wrap` in the effect that builds the state would throw the document away and take
	 * the selection and the scroll position with it — for a setting you toggle precisely to look
	 * at the line you are already on.
	 */
	const wrapping = useRef(new Compartment());
	/** The text the document was last seeded with, so a re-read that changed nothing is not a reload. */
	const seeded = useRef(text);
	const menu = useContextMenu();

	const appearance = useApp((s) => s.settings?.appearance);
	const codeLightTheme = appearance?.codeLightTheme;
	const codeDarkTheme = appearance?.codeDarkTheme;
	const highlightCompartment = useRef(new Compartment());

	useEffect(() => {
		const element = host.current;
		if (!element) return;

		seeded.current = text;
		const state = EditorState.create({
			doc: text,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				drawSelection(),
				rectangularSelection(),
				foldGutter(),
				bracketMatching(),
				highlightSelectionMatches(),
				/*
				 * ⌘F opens it, and it opens at the top.
				 *
				 * `searchKeymap` alone was already bound, which is why the shortcut appeared to do
				 * nothing — the bindings need a panel to open, and without `search()` there was
				 * none. Top rather than bottom because the composer-shaped things in this app all
				 * sit at the bottom of their pane, and a find bar down there reads as one of them.
				 */
				search({ top: true }),
				/*
				 * The panel's own wording, in the app's language.
				 *
				 * CodeMirror builds these strings into the panel's DOM, so there is no way to
				 * translate it from the outside — `phrases` is the hook it provides for exactly
				 * this. Missing keys fall through to the English original rather than blanking.
				 */
				EditorState.phrases.of(searchPhrases()),
				highlightCompartment.current.of(syntaxHighlighting(highlightStyle(codeLightTheme, codeDarkTheme))),
				/*
				 * 只读，两层都要。
				 *
				 * `readOnly` 拦的是命令，`editable` 拦的是 DOM：只设前者，内容区仍是 contentEditable，
				 * 输入法和拖放照样能把字塞进去。不可编辑的内容区默认拿不到焦点，⌘F 这些快捷键
				 * 就无处可按，所以补一个 `tabindex`。
				 */
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				EditorView.contentAttributes.of({ tabindex: "0" }),
				wrapping.current.of(wrap ? EditorView.lineWrapping : []),
				language.current.of([]),
				keymap.of([
					/*
					 * ⌘F toggles rather than only opens.
					 *
					 * `searchKeymap` binds it to open, so pressing it again with the panel already
					 * up did nothing at all — and the way out was a key you had to know about.
					 * The shortcut that summons a thing should dismiss it.
					 */
					{
						key: "Mod-f",
						preventDefault: true,
						run: (view) => (searchPanelOpen(view.state) ? closeSearchPanel(view) : openSearchPanel(view)),
					},
					...defaultKeymap,
					...searchKeymap,
					...foldKeymap,
				]),
				editorTheme(),
			],
		});

		const instance = new EditorView({ state, parent: element });
		view.current = instance;

		// CodeMirror builds the find bar on first open, so this watches for it rather than running once.
		const panels = new MutationObserver(() => labelSearchPanel(element));
		panels.observe(element, { childList: true, subtree: true });
		setScroller(instance.scrollDOM);

		let live = true;
		void languageFor(path)?.then((extension) => {
			// The file can be closed while its grammar is still being fetched.
			if (live && extension) instance.dispatch({ effects: language.current.reconfigure(extension) });
		});

		return () => {
			live = false;
			instance.destroy();
			view.current = null;
			setScroller(null);
		};
		// `text` is deliberately absent: a re-read of the same file is adopted below without
		// losing the scroll position. `wrap` likewise — it seeds the compartment above and is
		// reconfigured, never rebuilt.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path]);

	useEffect(() => {
		view.current?.dispatch({
			effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
		});
	}, [wrap]);

	useEffect(() => {
		view.current?.dispatch({
			effects: highlightCompartment.current.reconfigure(
				syntaxHighlighting(highlightStyle(codeLightTheme, codeDarkTheme)),
			),
		});
	}, [codeLightTheme, codeDarkTheme]);

	/** The file changed on disk and was read again: show the new text in the same view. */
	useEffect(() => {
		const instance = view.current;
		if (!instance || text === seeded.current) return;
		seeded.current = text;
		instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: text } });
	}, [text]);

	function openFind() {
		const instance = view.current;
		if (instance && !searchPanelOpen(instance.state)) openSearchPanel(instance);
	}

	return (
		// `relative` so the thumbs can be positioned against the pane rather than the window.
		<div className="ly-scroll-host relative flex min-h-0 flex-1">
			{/* noStaticElementInteractions 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: the menu is the editor's, not this box's. */}
			<div
				ref={host}
				onContextMenu={(event) => menu.show(event, undefined)}
				className="ly-cm min-h-0 min-w-0 flex-1 overflow-hidden"
			/>
			{scroller && (
				<>
					<OverlayScrollbar viewport={scrollerRef} orientation="vertical" />
					<OverlayScrollbar viewport={scrollerRef} orientation="horizontal" />
				</>
			)}
			{menu.open && (
				<EditorMenu
					anchor={menu.anchor}
					onClose={menu.close}
					view={view.current}
					path={path}
					onFind={openFind}
				/>
			)}
		</div>
	);
}


/**
 * The grammar for a path, or null when nothing here can parse it.
 *
 * Name first, extension second — `grammarKeyFor` is where that rule lives, because the editor is
 * not the only thing that asks. `Dockerfile` and `Makefile` used to be checked here only to be
 * turned down; they have grammars now.
 */
function languageFor(path: string): Promise<Extension | null> | null {
	const key = grammarKeyFor(path);
	if (!key) return null;
	const load = GRAMMARS[key];
	return load ? load().catch(() => null) : null;
}
