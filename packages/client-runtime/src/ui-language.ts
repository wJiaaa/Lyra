/**
 * 回复里 ```ui 块的语言，转给手机。手机只依赖这个包，而这份规则必须和桌面、提示词、检查是同一份；
 * 转出去的那几个文件不出自己的目录，在 React Native 里一样能跑（见 .dependency-cruiser.cjs）。
 */

export * from "@plume/core/ui-language";
