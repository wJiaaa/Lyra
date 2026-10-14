# 设计体系

桌面端渲染进程的视觉语言，一份写全。它一直都在——散在 `tokens.css`、`theme.ts`、几个基础组件和
三条 ADR 里——这里把它们收成一张表，每一项都指回真正定义它的地方。**这份文档不是真相，代码是**：
两边对不上时以代码为准，并顺手改这里。

样张：[design-system-specimen.html](design-system-specimen.html)，浏览器直接打开。它照
`theme.ts` 的公式重算了一遍色板，可以拖背景、前景、强调色和对比度看派生结果；数值是 2026-10-14
的快照，不随代码更新。

手机端（`packages/mobile/src/ui.tsx`）是独立的一套：自己的色板和字号，只和桌面共用强调色
`#339CFF` 与状态色的色相，见 [ADR-0041](../adr/0041-native-mobile-shared-runtime.md)。本文不覆盖它。

## 真相在哪

| 东西 | 定义在 | 守它的 |
| --- | --- | --- |
| 色、圆角、阴影、尺寸、字阶、动效的初值 | `packages/desktop/src/styles/tokens.css` 的 `@theme` | stylelint `color-no-hex`、时长、圆角、阴影规则；组件里的类名由 `test/design-tokens.test.ts` 扫 |
| 色板的运行时派生 | `packages/desktop/src/features/settings/theme.ts` 的 `applyAppearance` | `test/appearance-defaults.test.ts` |
| 出厂外观（三个颜色、字号、对比度） | `packages/core/src/config/settings.ts` 的 `DEFAULT_APPEARANCE` | 同上，比对 `appearance-defaults.ts` |
| 动效常量的 JS 副本 | `packages/desktop/src/ui/motion/tokens.ts` | `test/ui/motion-tokens.test.ts`，[ADR-0014](../adr/0014-motion-tokens-in-two-places.md) |
| 按钮 | `ui/primitives/Button.tsx`、`IconButton.tsx` | [ADR-0013](../adr/0013-one-button-two-heights.md) |
| 字阶与字重的配对 | `ui/primitives/Text.tsx` 的 `DEFAULT_WEIGHT` | — |
| 样式三分法（色、时长、类名） | `stylelint.config.mjs` | `pnpm style`，[ADR-0015](../adr/0015-styles-are-checked-not-agreed.md) |
| 图标 | `ui/icons/index.ts`（lucide + 悬停动画版） | oxlint `no-restricted-imports`、`test/ui/icons-animated.test.ts` |

## 颜色

### 三个输入，其余派生

用户能设的只有三样：**背景、前景、强调色**，外加一个**对比度**滑条（0–100，映射成 0.5×–1.5× 的
倍率）。其余每一个颜色都是背景往前景方向按比例混出来的，所以换任何背景都不会得到读不清的字或看不见
的线。这是整套颜色的地基——一个手写的 hex 就是一块不听用户选择的表面，stylelint 因此禁掉了它。

出厂值：

| | 浅色 | 深色 |
| --- | --- | --- |
| 背景 | `#F8F8F8` | `#171717` |
| 前景 | `#262626` | `#D4D4D4` |
| 强调色 | `#339CFF` | `#339CFF` |
| 对比度 | 60 | 60 |

主题默认跟随系统；`.dark` / `.light` 挂在 `<html>` 上，Tailwind 的 `dark:` 跟它走而不是跟
`prefers-color-scheme` 走（`styles.css` 末尾）。

### 表面

从下往上叠。名字是 Tailwind 工具类的后缀：`bg-shell`、`bg-card`……

| token | 用在 | 派生 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `shell` | 内容卡片（对话、面板、独立页面）的底 | 背景本身 | `#f8f8f8` | `#171717` |
| `sidebar` | 窗口底层：侧栏、卡片之间露出的 4px 缝、Windows 的标题条 | `surface(0.042)` | `#f4f4f4` | `#202020` |
| `card` | 卡片 | `surface(0.06)` | `#f2f2f2` | `#232323` |
| `card-hover` | 行与按钮的悬停底 | 前景 5% / 6.2% 的薄纱 | — | — |
| `elevated` | 按下、选中再深一档 | 前景 8.5% / 10% 的薄纱 | — | — |
| `input` | 输入框——「纸」 | 浅色往**白**混 65%；深色 `surface(0.035)` | `#fdfdfd` | `#1e1e1e` |
| `float` | 菜单、弹窗、tooltip | 浅色往**白**混 80%；深色 `surface(0.1)` | `#fefefe` | `#2c2c2c` |

两条不对称是故意的，都在 `theme.ts` 里写了原因：

- **浅色主题上，输入框和浮层往白走，不往前景走。** 往前景走会让输入框比页面灰、菜单比它盖住的东西
  暗——可你要打字的地方应该是屏幕上最亮的面，浮起来的东西应该比底下亮。
- **浅色主题上，表面靠近页面（×0.45），分隔线远离页面（×1.7）。** 两者同一条曲线时，线
  （`#ececed`）比它要分开的卡片（`#f0f0f0`）还浅，层次只能靠一层层变灰来挣，「整个应用发灰」就
  是这么来的。

薄纱（`card-hover`、`elevated`、`line-float`）是前景按透明度盖上去，不是一个实色：它落在什么上面
都高出同样一截，所以浮层里的悬停和页面上的悬停是同一个深度差。

### 线

| token | 用在 | 派生 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `line` | 默认边框（`*` 的 `border-color`） | `rule(0.075)` | `#dbdbdb` | `#272727` |
| `line-soft` | 同一张卡片内部的分隔 | `rule(0.05)` | `#e4e4e4` | `#212121` |
| `line-float` | 浮层的描边与分隔 | 前景 10% 的薄纱 | — | — |

浮层不用 `line`：`rule()` 以页面为参照，画在 `surface(0.1)` 的菜单上反而比菜单暗，深色下直接看
不见。

### 墨色

| token | 用在 | 派生 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `ink` | 正文 | 前景本身 | `#262626` | `#d4d4d4` |
| `ink-muted` | 次要文字 | 前景 70% | `#656565` | `#9b9b9b` |
| `ink-faint` | 占位、未选中的图标、时间戳 | 浅色 52%、深色 56% | `#8b8b8b` | `#818181` |

**两档灰的下限按它坐着的最浅那张面算，不按页面算**：在 `shell` `sidebar` `card` `input` `float`
每一种上，muted ≥4.5:1、faint ≥3:1，两者之比 ≥1.3（`test/ui/text-greys.test.ts`）。2026-10-14 之前
是 60% / 40%（深色 50%），只在页面上够——深色菜单上 muted 3.9:1，浅色 faint 2.3:1，读起来灰、发飘。
Windows 浅色原来单独加深的那一档（雅黑没有 Medium，画得更细）随之去掉：所有平台都已经在它之上。

### 状态与图表

| token | 值 | 用在 |
| --- | --- | --- |
| `accent` | 跟设置 | 选中、开关、焦点环、主要的「这里」 |
| `ok` | `#3ecf8e` | 成功、新增 |
| `danger` | `#f2555a` | 删除、错误。按钮只在悬停时上色 |
| `violet` | `#b18cf5` | 少量标记 |
| `--ly-warning` | 浅 `#d97706` / 深 `#fbbf24` | 警告——它没有 `color-` 前缀，是后来补的 |
| `--ly-chart-1…6` | 第一色跟强调色，其余五色分深浅 | 回复里的图表、生成页面（`preview-theme.ts` 从根上读） |

状态色只有这几个。整套的调色是**一个强调色加三个状态**，不要为一个新功能引第五种颜色——它会是
唯一一个不跟主题走的地方。

状态色在两种主题下**是同一个值，这是有意的**：成功、错误要在哪种底上都是同一个意思，跟着主题换色
反而让人重新认一遍。

「信息」没有自己的颜色，就用 `accent`。曾经有过一个 `info`，运行时永远等于 `accent`，两个名字指同
一个颜色，读的人会以为它们不同；`panel` 也一样，和 `sidebar` 只差 0.2%，肉眼分不出。两个都已删掉。
多序列的图表（用量图、提交图的泳道）第四色接 `--ly-chart-3`，不再和第一色撞成同一个蓝。

### 代码

代码面有自己的一组，来自所选的语法主题：`--ly-code-bg`、`--ly-code-fg`、`--ly-code-bg-soft`（行号
槽，代码底往字色混 5%）、`--ly-inline-code-bg/fg/ring`、`--ly-diff-added-bg/removed-bg`。默认主题
`plume-light` / `plume-dark` 是 `inherit`，即用应用自己的背景。文件、文件树、终端、审阅这几种面板会在自己的卡片上把整组 `--color-*` 重绑到代码主题
（`dock.css`），于是面板里的按钮、线和字不用改一行就跟着语法主题走。语法高亮的 token 色在
`styles/code-tokens.css`，那里是唯一允许 hex 的样式文件之一——高亮要的是彼此分得开的色相，不是从
三个颜色派生得出来的东西。

## 字体与字阶

不打包字体：界面用系统无衬线（`--font-sans`，钉死在 Tailwind 4.2 的那套栈，不随版本漂），代码用
系统等宽，中文回退写在 `monospace` 之前（Consolas 没有中文字形）。全局 `tabular-nums`。

七级，全部 `calc()` 自用户设置的「界面字号」`--ly-ui-size`（默认 14px），拖一个滑条整套一起动：

| 步 | 工具类 | 大小 | 行高 | 字距 | 默认字重 | 用在 |
| --- | --- | --- | --- | --- | --- | --- |
| display | `text-display` | +16 → 30px | 1.2 | -0.022em | 600 | 每屏一个的页标题 |
| heading | `text-heading` | +7 → 21px | 1.3 | -0.015em | 600 | 一屏的大分区 |
| title | `text-title` | +3 → 17px | 1.4 | -0.01em | 500 | 段落、卡片标题 |
| body | `text-body` | +1 → 15px | 1.7 | — | 400 | 消息、说明——一句一句读的 |
| label | `text-label` | 14px | 1.5 | — | 400 | 行、控件、表格——应用的工作字号 |
| detail | `text-detail` | -1 → 13px | 1.5 | — | 400 | 标签下面那行补充 |
| caption | `text-caption` | -2 → 12px | 1.45 | — | 400 | 时间、计数、角标 |
| code | `text-code` | `--ly-code-size`（12） | 设置，默认 1.6 | 设置，默认 0 | 400 | 一切画代码的地方 |

- **层级靠两根轴分开：大小和字重。** 字重在 `Text.tsx` 里和字阶配一次，不写进 `@theme`——写进去
  的话后来的 `font-medium` 能不能赢就取决于工具类的顺序。
- **字越大字距越紧。** 13px 合适的字距到 26px 就松了。
- **不要写 `text-[Npx]`。** 351 处这样的写法曾经让「界面字号」设置几乎不起作用；现在全库剩 12 处，
  多是图标角标那种 9–11px 的特例。

## 尺寸

### 控件高度

| 高度 | 是谁 |
| --- | --- |
| 34px `--ly-control` | 字段 `.ly-field`、下拉、对话框底部的动作——同一个无描边胶囊（`--radius-field: 999px`，`card` 底）；设置页、对话框、弹出层里收成 8px（`overlay.css`） |
| 32px | `Button` `md`（默认）；菜单行 `--ly-menu-row` |
| 28px `--ly-composer-control` | 输入框工具条上的每一颗；卡片标题栏的按钮 |
| 26px | `Button` `sm`；`IconButton` `md`（默认） |
| 22px | `IconButton` `sm` |
| 20px | `Button` / `IconButton` `xs`——跟在一句话末尾、一行说明里 |

`Button` 不接受 `style`：重点就是让调用方发明不出第九种高度。

### 圆角

**只用 Tailwind 的刻度**：xs 2 / sm 4 / md 6 / lg 8 / xl 12 / 2xl 16 / 3xl 24，加 `rounded-full`。
落在两档中间的往小取。收口之前组件里有 22 种圆角，10、11、13、14px 并排出现，没有一个是有意不同
的；现在 10px 那一大组（设置里的卡片和提示、工具卡片、代码块、画廊方块）是 8px，18px（消息编辑框、
斜杠和 @ 菜单、提交弹窗、关于页图标）是 16px，11/13/14 是 12px。

样式表里 `border-radius` 写像素会被 stylelint 拦（`999px` / `9999px` 的胶囊除外）；tsx 里的
`rounded-[Npx]`、内联 `borderRadius: "Npx"` 由 `test/design-tokens.test.ts` 拦。按尺寸比例算出来的
圆角（插件图标的 `size * 0.235`、SVG 路径里的弯）是公式，不算又一档。

按钮的规则：**约 22px 及以上 8px（`rounded-lg`），20px 及以下 6px（`rounded-md`）**。有语义的几档：

| token / 值 | 用在 |
| --- | --- |
| `--radius-field` 999px | 字段、下拉、对话框动作 |
| `--radius-menu` 8px | 菜单卡片 |
| `--radius-item` 6px | 菜单里的行；内衬 `--ly-menu-inset` 4px，四边一样，悬停底才不会左近右远 |
| `--radius-panel` 12px | 面板 |
| 16px（`rounded-2xl`） | 对话框；输入框外的托盘 `.ly-composer-tray` |
| 8px 外框、6px 滑块和每一格 | 分段控件：`TabStrip`、设置页的 `Segmented`，在哪儿都一样。两者是同一种控件，曾经一个胶囊一个小圆角，同一页上看着像两套 |
| `rounded-full` | 开关、头像、圆点、胶囊角标 |

### 间距

间距读变量，不写字面量——抄成 `12px` 以后就和源头断了。

| token | 值 | 是什么 |
| --- | --- | --- |
| `--ly-composer-in` | 12px | 输入框卡片里每一处内衬：文字上下、附件条、工具条下沿 |
| `--ly-composer-x` | 16px | 卡片内的水平内衬，也是窄窗口的边距 |
| `--ly-composer-out` | 24px | 卡片到面板边、到窗口底 |
| `--ly-frame-pad` | 2px | 工作区包住各块的内衬；和卡片的 2px 外边距合成卡片之间 4px 的缝 |
| `--ly-pane-chrome` | 5px | 卡片内容离窗口的距离：frame pad + `PANE_INSET` 2 + 1px 边框。和 `geometry.ts` 同步 |

工作区是「侧栏铺在窗口材质上，每块内容一张圆角卡片，彼此隔 4px」，缝上不画线，见
[ADR-0038](../adr/0038-window-frame-toolbar-rail-cards.md) 第 7 条。窗口底层是 `sidebar`（macOS 开毛玻璃时
换成半透明的 `--ly-window-tint`）；卡片 `.ly-dock-card` / `.ly-card-page` 是 `shell` 底、前景 10% 的
描边、`--radius-panel` 圆角，**不投影**——只靠缝里露出的窗口底色分层。

## 深度

**深度从底子来。** 先问一句「这一层深度是从哪儿来的」，再决定加不加阴影或边框
（AGENTS.md「换的是深度，不是圆角」）：

- 浮起来的东西上不再浮一块：弹窗里的输入框不带主输入框那两层阴影。
- 边界只画一次：框有了下沿，就不再在它和下面那排动作之间横一条线。
- 卡片里的卡片、有边框的容器里再套边框，都是同一件事说两遍。

阴影只有 `tokens.css` 里这几档，工具类是 `shadow-rest`、`shadow-menu`……两种主题同一组，深色只重
定义 `glass` 和 `knob`：

| token | 值 | 谁 |
| --- | --- | --- |
| `--shadow-rest` | `0 20px 25px -5px / 5%`、`0 8px 10px -6px / 5%`（Tailwind `shadow-xl` 压到 5%） | 主输入框，或它外面的托盘——二选一，两层都投会多一道暗缝 |
| `--shadow-menu` | `0 4px 6px -1px / 10%`、`0 2px 4px -2px / 10%`（`shadow-md`） | `.ly-menu-card`、浮层 |
| `--shadow-tip` | `0 4px 14px -4px / 30%` | `.ly-tooltip`，不反色，`float` 底加 `line-float` 边 |
| `--shadow-dialog` | `0 18px 60px / 16%`、`0 2px 8px / 6%` | `.ly-dialog-surface`、文档预览的纸 |
| `--shadow-overlay` | `0 8px 32px / 45%` | 盖在图片和截图上的东西：图片查看器、标注工具条、截图浮层、钉住的截图、拖放提示 |
| `--shadow-knob` | 浅 `0 1px 2.5px / 16%`，深 `0 1px 3px / 55%` | 开关旋钮、分段控件的滑块 |
| `--shadow-glass` | 顶边一道内高光 + 两层投影，深色更重 | `.ly-glass`（92% 不透明 + 模糊）、`.ly-glass-solid`（在带遮罩的滚动区里用这个，模糊在那里不生效）、文件动作条 |

描边不是阴影：要一圈细线用 `ring-1`（`ring-line`、`ring-black/35`），不写 `shadow-[0_0_0_1px_…]`。
分段控件滑块浅色下那道 0.5px 的边是 `outline`，深色没有——深色底上滑块本身就比槽亮。

`box-shadow` 里写 `rgb()` 会被 stylelint 拦，tsx 里的 `shadow-[…]` 由 `test/design-tokens.test.ts`
拦。唯一放过的是关于页图标底下那道强调色光晕，只此一处，行内注明了理由。

菜单曾经是 `.ly-glass`，看上去又厚又花，已换成 `.ly-menu-card`：浮层几乎不透明，模糊透不出什么。

## 动效

三个时长、三条曲线（`tokens.css`，JS 副本在 `ui/motion/tokens.ts`）。时长按**什么在动**分，不按
重要程度分：

| token | 值 | 是什么在动 |
| --- | --- | --- |
| `--ly-t-quick` | 150ms | 一个状态，不是位置：悬停、按下、颜色变化 |
| `--ly-t-base` | 220ms | 某个东西在移动或改尺寸：面板、滑块、让出宽度的一列 |
| `--ly-t-slow` | 340ms | 原来不在的东西到来：一段展开 |

| token | 曲线 | 用在 |
| --- | --- | --- |
| `--ly-e-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 进场：减速落定，看上去是停稳了而不是被卡住 |
| `--ly-e-in` | `cubic-bezier(0.55, 0, 1, 0.45)` | 离场 |
| `--ly-e-soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | 原地的颜色、描边变化：输入框描边、发送按钮 |

- **`transition` 的时长和曲线只能用 token**，stylelint 拦。「减少动态效果」靠把 `--ly-t-*` 归零
  实现，手写的 `200ms` 会在别的东西都停了的时候继续动。
- **`animation` 不在此列**：呼吸 2.4s、扫光 1.4s 是关键帧动画本身的一部分。全局 reduce-motion 规则
  （`motion.css`，三档：跟随系统 / 开 / 关）一次压住全部。
- **按下不缩放**：一个在接触那一刻跳开的控件读起来不稳。按下是底色深一档（`active:bg-elevated`）。
- **退场不是进场倒放**：tooltip 进场轻微过冲，退场更快且不缩放。
- **换主题时先冻住过渡**：`applyAppearance` 写变量前挂 `data-theme-switching`，两帧后摘，避免屏幕上
  同时出现两套颜色。只在颜色真的变了时冻。

更多流畅度上的约束（只动合成层、可中断、内容到达不重排）见
[流畅度对照清单](smoothness-checklist.md)。

## 组件

基础组件在 `packages/desktop/src/ui/`，不读 store、不调 service——换个产品也成立。

| 组件 | 要点 |
| --- | --- |
| `Button` | `primary`（墨底、反色字，不引入颜色）/ `ghost`（描边，默认）/ `subtle`（无描边）/ `danger`（悬停才变红）；`md` `sm` `xs`；`loading` 不改宽度、带 `aria-busy`；`pressed` 是悬停态被按住 |
| `IconButton` | `label` 同时是 tooltip 和无障碍名，不能只给一个；`emphasis` 用全墨色表示「这颗现在值得按」，不用填色；角标在图标外，数字变化不挪动行 |
| `Text` | 七级字阶 × `default` `muted` `faint` `danger` `accent` 五种墨色；`numeric` 给会原地跳动的数字 |
| `Menu` | `float` 底卡片，行高 32、圆角 6、内衬 4；分隔线 `line-float`；行内开关 28×16 |
| `Dialog` / `Overlay` | `float` 底、`line-float` 边、16px 圆角、最高 85dvh；内衬 20px（`px-5`）；底部动作 `.ly-dialog-action` 是 34px 无描边胶囊：secondary `card` 底 + `ink-muted`，primary 墨底，danger 10% 红底 |
| `Tooltip` | 整个窗口一个，挂在 `data-ly-tip` 属性上，CodeMirror 生成的节点也能用；禁用的控件默认不弹，除非 `explainDisabled` |
| 开关旋钮 `.ly-knob` | 两种主题都是白色；灰旋钮压在强调色上读起来是「脏了一块」 |
| 图标 | 一律从 `ui/icons` 导入 lucide，描边 2；悬停整颗按钮时播放动画版 |
| 滚动 | 全局隐藏原生滚动条，一律走 `<Scroller>` 的浮层滑块 |

焦点：去掉了 Chromium 的默认轮廓，`:focus-visible` 统一是 2px 强调色、外移 2px（`base.css`）。

## 命名与检查

- 我们的类名是 `ly-…`，其余是别人的（`cm-`、`xterm`、`katex`、`docx`）。
- 自定义属性前缀：`ly-`、`color-`、`font-`、`text-`、`radius-`、`shadow-`。
- 只有 `tokens.css`、`code-tokens.css` 可以写 hex；做遮罩的几个文件可以写 `#000`
  `#fff`，那是 alpha 通道不是颜色。
- 新 token 要在 `@theme` 里声明一次，哪怕运行时会覆盖它——不声明 Tailwind 就不生成对应的工具类，
  用到的地方会完全透明（`--color-float` 的注释讲的就是这件事）。
- 改完样式跑 `pnpm style`。

## 加一样新东西之前

1. 先找现成的 token 和组件。颜色只有表里那些；高度只有表里那些。
2. 真需要新 token：写进 `tokens.css` 对应的组里（分组是意思，不是格式），要随主题变的在
   `applyAppearance` 里派生，并在本文补一行。
3. 照着别处做一个东西时，换的是深度，不是整段类名——见上面「深度」。
4. 在真窗口里浅色、深色各看一遍。

## 已知的偏差

扫出来、还没收的。按 ADR-0013 的做法：新代码照规矩来，旧的随手改，不做一次性的大替换。

- **手写 `<button>` 还有 205 处**，`<Button>` 112 处、`<IconButton>` 171 处。
- **tooltip 的动画写死了 `150ms` 和自己的曲线**——在 `animation` 上，所以不违反规则，但和
  `--ly-t-quick` 是同一个数。
- **`--ly-warning` 没有 `color-` 前缀**，因此没有 `text-warning` 这样的工具类。眼下只有界面块
  （`interface.css`）和生成页面（`preview-theme.ts`）读它，组件里要用警告色得先补这一步。
- **`bg-hover` 没有对应的 token。** `TraceInspector`、`TrajectoryPanel` 里写了 `bg-hover` /
  `hover:bg-hover`，但没有 `--color-hover`，这几处悬停其实什么都不画。该用的是 `card-hover`。
