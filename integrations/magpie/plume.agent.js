// Plume 作为 magpie 的 Agent：在 magpie 的 Agent 页给 Plume 选一个 magpie 的模型。
//
// Plume 的供应商是 settings.json 里的 `providers` 数组，magpie 只会按点分路径改对象键，定位不到数组
// 里的一项；所以这里写的是顶层的 `magpie` 对象，Plume 读入时把它合成一个供应商
// （packages/core/src/config/magpie.ts）。模型 id 是 `magpie/<供应商>/<模型>`，与那个供应商下的模型同名。
import { icon } from "./icon.js";

export const agent = {
	id: "plume",
	name: "Plume",
	icon,
	// 桌面应用，PATH 上没有命令；装过、开过一次就有这个目录
	dir: "~/.plume",
	config: "~/.plume/settings.json",
	model: "defaultModelId",
	prefix: "magpie/",
	notice: "Plume reads its settings when it starts: restart Plume to use the new model.",
};

export function connect({ gateway, models }) {
	return {
		// 不带 /v1：Plume 的适配器拼路径时自己处理 /v1
		"magpie.baseUrl": gateway.url,
		// magpie 看这一键是否还是它给的 key，来判断这一行是否仍然接着
		"magpie.apiKey": gateway.key,
		// 整份目录写进去，Plume 的模型选择器从这里列；magpie 的目录变了会重新调 connect
		"magpie.models": models,
	};
}
