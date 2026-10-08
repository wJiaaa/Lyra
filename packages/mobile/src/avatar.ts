import type { ImageSourcePropType } from "react-native";

/**
 * Plume 的头像，和 App 图标是同一张图（缩到 252px，够 84pt 的 @3x）：连接页和空会话里用它。
 * 放在包内而不直接引用仓库根的 assets/plume.png——Metro 开发服务器按包根拼资源地址，包外的图在原生端会 404。
 */
export const avatar: ImageSourcePropType = require("../assets/avatar.png");
