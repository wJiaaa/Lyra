/**
 * 应用里所有 lucide 图标的入口：从这里 import，不要直接从 `lucide-react` import（`.oxlintrc.json`
 * 的 `no-restricted-imports` 会拦，类型除外）。
 *
 * 代码里用到的每个图标这里都导出动画版，名字和 lucide 一样，所以调用处只写 `<Bell size={15} />`，
 * 和以前一样。下面的 `export *` 只是为了类型（`LucideIcon`、`LucideProps`）和以后新用到的图标：
 * 新图标在补上动画版之前拿到的是不会动的原版，`test/ui/icons-animated.test.ts` 会把它指出来。
 *
 * 动画版相对上游改了三处，`animated/` 里每个文件都是这样，是脚本照同一个模板生成的：
 * - 接口照 lucide-react：`forwardRef` 到 `<svg>`，默认 24px、描边 2，`className`、`style`、`fill`
 *   这些都落在 `<svg>` 上，带 `lucide lucide-<名字>` 类名，没有包一层 div。上游的 28px 默认值和
 *   外层 div 会让 `className="h-4 w-4"` 这类写法失效，测试里按 `svg.lucide-settings` 找按钮也会落空。
 * - 不再自己监听鼠标，悬停整个按钮时播放，规则见 `useHoverAnimation.ts`。
 * - 第一次悬停之前画成不带动画的普通元素（模板里的 `M.path` 而不是 `motion.path`），一列几百个
 *   行内按钮的图标平时和 lucide 原版一样便宜。
 *
 * `animated/` 里有两类文件，开头的注释说明是哪一类：
 * - 照搬上游 lucide-animated（https://lucide-animated.com）的。上游有一批画的是旧版 lucide（铃铛、
 *   齿轮、分支……），这些换成了 lucide 现在的形状，动画仍挂在原来的部件上。
 * - 上游没有、照它的写法补的：形状是 lucide 的元素，动作是上游常用的那几种（推一下、画出来、鼓一下、
 *   晃一下），时长 0.3～0.6 秒。
 *
 * 新增一个动画图标：上游有就把上游文件按同样的改法放进 `animated/`，没有就照第二类补一个，再在下面加
 * 一行导出。只导出代码里用到的名字（`Bell` 用到了就导出 `Bell`），没用到的导出会被 knip 拦下。
 * 先按 lucide 现在的名字找上游文件，上游还用旧名的照 lucide 的别名对上（`house` 是上游的 `home`）。
 * 名字对上但画的不是同一个东西的不要接：上游的 `delete` 是垃圾桶，lucide 的 `Delete` 是退格键，
 * 所以这里是 `trash-2` 用了上游的 `delete`。
 */

export * from "lucide-react";
export { ActivityIcon as Activity } from "./animated/activity.tsx";
export { AnchorIcon as Anchor } from "./animated/anchor.tsx";
export { AppWindowIcon as AppWindow } from "./animated/app-window.tsx";
export { ArchiveIcon as Archive } from "./animated/archive.tsx";
export { ArchiveRestoreIcon as ArchiveRestore } from "./animated/archive-restore.tsx";
export { ArrowDownIcon as ArrowDown } from "./animated/arrow-down.tsx";
export { ArrowDownLeftIcon as ArrowDownLeft } from "./animated/arrow-down-left.tsx";
export { ArrowDownRightIcon as ArrowDownRight } from "./animated/arrow-down-right.tsx";
export { ArrowDownToLineIcon as ArrowDownToLine } from "./animated/arrow-down-to-line.tsx";
export { ArrowLeftIcon as ArrowLeft } from "./animated/arrow-left.tsx";
export { ArrowLeftRightIcon as ArrowLeftRight } from "./animated/arrow-left-right.tsx";
export { ArrowRightIcon as ArrowRight } from "./animated/arrow-right.tsx";
export { ArrowRightLeftIcon as ArrowRightLeft } from "./animated/arrow-right-left.tsx";
export { ArrowUpIcon as ArrowUp } from "./animated/arrow-up.tsx";
export { ArrowUpDownIcon as ArrowUpDown } from "./animated/arrow-up-down.tsx";
export { ArrowUpFromLineIcon as ArrowUpFromLine } from "./animated/arrow-up-from-line.tsx";
export { ArrowUpLeftIcon as ArrowUpLeft } from "./animated/arrow-up-left.tsx";
export { ArrowUpRightIcon as ArrowUpRight } from "./animated/arrow-up-right.tsx";
export { AtSignIcon as AtSign } from "./animated/at-sign.tsx";
export { BanIcon as Ban } from "./animated/ban.tsx";
export { BellIcon as Bell } from "./animated/bell.tsx";
export { BinaryIcon as Binary } from "./animated/binary.tsx";
export { BlocksIcon as Blocks } from "./animated/blocks.tsx";
export { BookOpenIcon as BookOpen } from "./animated/book-open.tsx";
export { BookmarkIcon as Bookmark } from "./animated/bookmark.tsx";
export { BotIcon as Bot } from "./animated/bot.tsx";
export { BoxIcon as Box } from "./animated/box.tsx";
export { BoxesIcon as Boxes } from "./animated/boxes.tsx";
export { BracesIcon as Braces } from "./animated/braces.tsx";
export { BrainIcon as Brain } from "./animated/brain.tsx";
export { BugIcon as Bug } from "./animated/bug.tsx";
export { CableIcon as Cable } from "./animated/cable.tsx";
export { CalendarDaysIcon as CalendarDays } from "./animated/calendar-days.tsx";
export { CalendarPlusIcon as CalendarPlus } from "./animated/calendar-plus.tsx";
export { CameraIcon as Camera } from "./animated/camera.tsx";
export { ChartColumnIcon as BarChart3 } from "./animated/chart-column.tsx";
export { ChartLineIcon as ChartLine } from "./animated/chart-line.tsx";
export { CheckIcon as Check } from "./animated/check.tsx";
export { ChevronDownIcon as ChevronDown } from "./animated/chevron-down.tsx";
export { ChevronLeftIcon as ChevronLeft } from "./animated/chevron-left.tsx";
export { ChevronRightIcon as ChevronRight } from "./animated/chevron-right.tsx";
export { ChevronUpIcon as ChevronUp } from "./animated/chevron-up.tsx";
export { ChevronsDownIcon as ChevronsDown } from "./animated/chevrons-down.tsx";
export { ChevronsDownUpIcon as ChevronsDownUp } from "./animated/chevrons-down-up.tsx";
export { ChevronsUpDownIcon as ChevronsUpDown } from "./animated/chevrons-up-down.tsx";
export { CircleIcon as Circle } from "./animated/circle.tsx";
export { CircleAlertIcon as AlertCircle, CircleAlertIcon as CircleAlert } from "./animated/circle-alert.tsx";
export { CircleCheckIcon as CheckCircle2, CircleCheckIcon as CircleCheck } from "./animated/circle-check.tsx";
export { CircleDashedIcon as CircleDashed } from "./animated/circle-dashed.tsx";
export { CircleQuestionMarkIcon as CircleHelp } from "./animated/circle-question-mark.tsx";
export { CircleSlashIcon as CircleSlash } from "./animated/circle-slash.tsx";
export { CircleStopIcon as CircleStop } from "./animated/circle-stop.tsx";
export { CircleXIcon as CircleX, CircleXIcon as XCircle } from "./animated/circle-x.tsx";
export { ClipboardPasteIcon as ClipboardPaste } from "./animated/clipboard-paste.tsx";
export { ClockIcon as Clock } from "./animated/clock.tsx";
export { CloudDownloadIcon as CloudDownload } from "./animated/cloud-download.tsx";
export { CloudUploadIcon as CloudUpload } from "./animated/cloud-upload.tsx";
export { CodeIcon as Code } from "./animated/code.tsx";
export { CodeXmlIcon as CodeXml } from "./animated/code-xml.tsx";
export { CoinsIcon as Coins } from "./animated/coins.tsx";
export { Columns2Icon as Columns2 } from "./animated/columns-2.tsx";
export { CopyIcon as Copy } from "./animated/copy.tsx";
export { CopyMinusIcon as CopyMinus } from "./animated/copy-minus.tsx";
export { CornerDownLeftIcon as CornerDownLeft } from "./animated/corner-down-left.tsx";
export { CornerLeftUpIcon as CornerLeftUp } from "./animated/corner-left-up.tsx";
export { CornerRightDownIcon as CornerRightDown } from "./animated/corner-right-down.tsx";
export { CornerUpRightIcon as CornerUpRight } from "./animated/corner-up-right.tsx";
export { CrosshairIcon as Crosshair } from "./animated/crosshair.tsx";
export { DatabaseIcon as Database } from "./animated/database.tsx";
export { DeleteIcon as Delete } from "./animated/delete.tsx";
export { DownloadIcon as Download } from "./animated/download.tsx";
export { EllipsisIcon as Ellipsis, EllipsisIcon as MoreHorizontal } from "./animated/ellipsis.tsx";
export { EllipsisVerticalIcon as MoreVertical } from "./animated/ellipsis-vertical.tsx";
export { EraserIcon as Eraser } from "./animated/eraser.tsx";
export { ExternalLinkIcon as ExternalLink } from "./animated/external-link.tsx";
export { EyeIcon as Eye } from "./animated/eye.tsx";
export { EyeOffIcon as EyeOff } from "./animated/eye-off.tsx";
export { FileIcon as File } from "./animated/file.tsx";
export { FileArchiveIcon as FileArchive } from "./animated/file-archive.tsx";
export { FileBracesIcon as FileJson } from "./animated/file-braces.tsx";
export { FileCodeIcon as FileCode } from "./animated/file-code.tsx";
export { FileDiffIcon as FileDiff } from "./animated/file-diff.tsx";
export { FileExclamationPointIcon as FileWarning } from "./animated/file-exclamation-point.tsx";
export { FileHeadphoneIcon as FileAudio } from "./animated/file-headphone.tsx";
export { FileImageIcon as FileImage } from "./animated/file-image.tsx";
export { FileLockIcon as FileLock } from "./animated/file-lock.tsx";
export { FileOutputIcon as FileOutput } from "./animated/file-output.tsx";
export { FilePlayIcon as FileVideo } from "./animated/file-play.tsx";
export { FilePlusIcon as FilePlus } from "./animated/file-plus.tsx";
export { FilePlusCornerIcon as FilePlus2 } from "./animated/file-plus-corner.tsx";
export { FileSpreadsheetIcon as FileSpreadsheet } from "./animated/file-spreadsheet.tsx";
export { FileTerminalIcon as FileTerminal } from "./animated/file-terminal.tsx";
export { FileTextIcon as FileText } from "./animated/file-text.tsx";
export { FileTypeIcon as FileType } from "./animated/file-type.tsx";
export { FilesIcon as Files } from "./animated/files.tsx";
export { FoldVerticalIcon as FoldVertical } from "./animated/fold-vertical.tsx";
export { FolderIcon as Folder } from "./animated/folder.tsx";
export { FolderArchiveIcon as FolderArchive } from "./animated/folder-archive.tsx";
export { FolderGit2Icon as FolderGit2 } from "./animated/folder-git-2.tsx";
export { FolderInputIcon as FolderInput } from "./animated/folder-input.tsx";
export { FolderOpenIcon as FolderOpen } from "./animated/folder-open.tsx";
export { FolderPlusIcon as FolderPlus } from "./animated/folder-plus.tsx";
export { FolderSearchIcon as FolderSearch } from "./animated/folder-search.tsx";
export { FolderTreeIcon as FolderTree } from "./animated/folder-tree.tsx";
export { FunnelIcon as Filter } from "./animated/funnel.tsx";
export { GitBranchIcon as GitBranch } from "./animated/git-branch.tsx";
export { GitBranchPlusIcon as GitBranchPlus } from "./animated/git-branch-plus.tsx";
export { GitCommitHorizontalIcon as GitCommitHorizontal } from "./animated/git-commit-horizontal.tsx";
export { GitCommitVerticalIcon as GitCommitVertical } from "./animated/git-commit-vertical.tsx";
export { GitCompareIcon as GitCompare } from "./animated/git-compare.tsx";
export { GitMergeIcon as GitMerge } from "./animated/git-merge.tsx";
export { GitPullRequestIcon as GitPullRequest } from "./animated/git-pull-request.tsx";
export { GitPullRequestArrowIcon as GitPullRequestArrow } from "./animated/git-pull-request-arrow.tsx";
export { GitPullRequestClosedIcon as GitPullRequestClosed } from "./animated/git-pull-request-closed.tsx";
export { GitPullRequestDraftIcon as GitPullRequestDraft } from "./animated/git-pull-request-draft.tsx";
export { GlobeIcon as Globe } from "./animated/globe.tsx";
export { Grid2x2Icon as Grid2x2 } from "./animated/grid-2x2.tsx";
export { GripVerticalIcon as GripVertical } from "./animated/grip-vertical.tsx";
export { HammerIcon as Hammer } from "./animated/hammer.tsx";
export { HandIcon as Hand } from "./animated/hand.tsx";
export { HardDriveIcon as HardDrive } from "./animated/hard-drive.tsx";
export { HashIcon as Hash } from "./animated/hash.tsx";
export { HouseIcon as House } from "./animated/house.tsx";
export { ImageIcon as Image } from "./animated/image.tsx";
export { InfoIcon as Info } from "./animated/info.tsx";
export { KeyRoundIcon as KeyRound } from "./animated/key-round.tsx";
export { LanguagesIcon as Languages } from "./animated/languages.tsx";
export { LayersIcon as Layers } from "./animated/layers.tsx";
export { LayoutGridIcon as LayoutGrid } from "./animated/layout-grid.tsx";
export { LibraryIcon as Library } from "./animated/library.tsx";
export { LightbulbIcon as Lightbulb } from "./animated/lightbulb.tsx";
export { LinkIcon as Link } from "./animated/link.tsx";
export { Link2Icon as Link2 } from "./animated/link-2.tsx";
export { ListIcon as List } from "./animated/list.tsx";
export { ListFilterIcon as ListFilter } from "./animated/list-filter.tsx";
export { ListOrderedIcon as ListOrdered } from "./animated/list-ordered.tsx";
export { ListTodoIcon as ListTodo } from "./animated/list-todo.tsx";
export { MailIcon as Mail } from "./animated/mail.tsx";
export { MailOpenIcon as MailOpen } from "./animated/mail-open.tsx";
export { Maximize2Icon as Maximize2 } from "./animated/maximize-2.tsx";
export { MessageCircleIcon as MessageCircle } from "./animated/message-circle.tsx";
export { MessageCirclePlusIcon as MessageCirclePlus } from "./animated/message-circle-plus.tsx";
export { MessageSquareIcon as MessageSquare } from "./animated/message-square.tsx";
export { MessageSquarePlusIcon as MessageSquarePlus } from "./animated/message-square-plus.tsx";
export { MessageSquareWarningIcon as MessageSquareWarning } from "./animated/message-square-warning.tsx";
export { MessagesSquareIcon as MessagesSquare } from "./animated/messages-square.tsx";
export { Minimize2Icon as Minimize2 } from "./animated/minimize-2.tsx";
export { MinusIcon as Minus } from "./animated/minus.tsx";
export { MonitorIcon as Monitor } from "./animated/monitor.tsx";
export { MousePointer2Icon as MousePointer2 } from "./animated/mouse-pointer-2.tsx";
export { MoveHorizontalIcon as MoveHorizontal } from "./animated/move-horizontal.tsx";
export { OctagonAlertIcon as OctagonAlert } from "./animated/octagon-alert.tsx";
export { OctagonPauseIcon as OctagonPause } from "./animated/octagon-pause.tsx";
export { PaletteIcon as Palette } from "./animated/palette.tsx";
export { PanelLeftIcon as PanelLeft } from "./animated/panel-left.tsx";
export { PanelRightOpenIcon as PanelRightOpen } from "./animated/panel-right-open.tsx";
export { PaperclipIcon as Paperclip } from "./animated/paperclip.tsx";
export { PauseIcon as Pause } from "./animated/pause.tsx";
export { PenLineIcon as Edit3 } from "./animated/pen-line.tsx";
export { PencilIcon as Pencil } from "./animated/pencil.tsx";
export { PencilLineIcon as PencilLine } from "./animated/pencil-line.tsx";
export { PinIcon as Pin } from "./animated/pin.tsx";
export { PinOffIcon as PinOff } from "./animated/pin-off.tsx";
export { PlayIcon as Play } from "./animated/play.tsx";
export { PlusIcon as Plus } from "./animated/plus.tsx";
export { PresentationIcon as Presentation } from "./animated/presentation.tsx";
export { PuzzleIcon as Puzzle } from "./animated/puzzle.tsx";
export { Redo2Icon as Redo2 } from "./animated/redo-2.tsx";
export { RefreshCwIcon as RefreshCw } from "./animated/refresh-cw.tsx";
export { RocketIcon as Rocket } from "./animated/rocket.tsx";
export { RotateCcwIcon as RotateCcw } from "./animated/rotate-ccw.tsx";
export { RotateCcwClockIcon as History } from "./animated/rotate-ccw-clock.tsx";
export { RotateCwIcon as RotateCw } from "./animated/rotate-cw.tsx";
export { SaveIcon as Save } from "./animated/save.tsx";
export { ScanIcon as Scan } from "./animated/scan.tsx";
export { ScissorsIcon as Scissors } from "./animated/scissors.tsx";
export { ScrollTextIcon as ScrollText } from "./animated/scroll-text.tsx";
export { SearchIcon as Search } from "./animated/search.tsx";
export { SendIcon as Send } from "./animated/send.tsx";
export { ServerIcon as Server } from "./animated/server.tsx";
export { SettingsIcon as Settings } from "./animated/settings.tsx";
export { Settings2Icon as Settings2 } from "./animated/settings-2.tsx";
export { ShieldCheckIcon as ShieldCheck } from "./animated/shield-check.tsx";
export { ShuffleIcon as Shuffle } from "./animated/shuffle.tsx";
export { SkipForwardIcon as SkipForward } from "./animated/skip-forward.tsx";
export { SlidersHorizontalIcon as SlidersHorizontal } from "./animated/sliders-horizontal.tsx";
export { SparklesIcon as Sparkles } from "./animated/sparkles.tsx";
export { SplitIcon as Split } from "./animated/split.tsx";
export { SquareIcon as Square } from "./animated/square.tsx";
export { SquareArrowOutUpRightIcon as SquareArrowOutUpRight } from "./animated/square-arrow-out-up-right.tsx";
export { SquareCheckBigIcon as CheckSquare } from "./animated/square-check-big.tsx";
export { SquareDashedTextIcon as TextSelect } from "./animated/square-dashed-text.tsx";
export { SquarePenIcon as SquarePen } from "./animated/square-pen.tsx";
export { SquareTerminalIcon as SquareTerminal } from "./animated/square-terminal.tsx";
export { StarIcon as Star } from "./animated/star.tsx";
export { StoreIcon as Store } from "./animated/store.tsx";
export { Table2Icon as Table2 } from "./animated/table-2.tsx";
export { TagIcon as Tag } from "./animated/tag.tsx";
export { TelescopeIcon as Telescope } from "./animated/telescope.tsx";
export { TerminalIcon as Terminal } from "./animated/terminal.tsx";
export { TextWrapIcon as WrapText } from "./animated/text-wrap.tsx";
export { Trash2Icon as Trash2 } from "./animated/trash-2.tsx";
export { TriangleAlertIcon as AlertTriangle, TriangleAlertIcon as TriangleAlert } from "./animated/triangle-alert.tsx";
export { TypeIcon as Type } from "./animated/type.tsx";
export { Undo2Icon as Undo2 } from "./animated/undo-2.tsx";
export { UploadIcon as Upload } from "./animated/upload.tsx";
export { UserIcon as User } from "./animated/user.tsx";
export { UserPlusIcon as UserPlus } from "./animated/user-plus.tsx";
export { UsersIcon as Users } from "./animated/users.tsx";
export { WandSparklesIcon as Wand2, WandSparklesIcon as WandSparkles } from "./animated/wand-sparkles.tsx";
export { WrenchIcon as Wrench } from "./animated/wrench.tsx";
export { XIcon as X } from "./animated/x.tsx";
export { ZapIcon as Zap } from "./animated/zap.tsx";
export { ZoomInIcon as ZoomIn } from "./animated/zoom-in.tsx";
export { ZoomOutIcon as ZoomOut } from "./animated/zoom-out.tsx";
