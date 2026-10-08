// iOS 27 在启动时断言 App 已采用 UIScene 生命周期，没采用的直接 SIGTRAP 退出
// （崩溃栈顶是 `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`）。
// iOS 26 只打警告，所以模拟器上看不出来。Expo 57 已经带了 `ExpoAppSceneDelegate`，但 prebuild 模板
// （到 57.0.29 为止）还没接上它；原生工程每次 prebuild 都重新生成，修法只能放在这个插件里。
// 模板改成自带场景代理之后，这个插件和 app.json 里那一行一起删掉。
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const WINDOW_BLOCK = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif\n/;
const DECLARATION = "class AppDelegate: ExpoAppDelegate {";

module.exports = function withSceneLifecycle(config) {
	config = withInfoPlist(config, (next) => {
		next.modResults.UIApplicationSceneManifest = {
			UIApplicationSupportsMultipleScenes: false,
			UISceneConfigurations: {
				UIWindowSceneSessionRoleApplication: [
					// `ExpoAppSceneDelegate` 在 Objective-C 里叫这个名字，不需要再写一个 Swift 子类。
					{ UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" },
				],
			},
		};
		return next;
	});
	return withAppDelegate(config, (next) => {
		let source = next.modResults.contents;
		if (source.includes("ExpoReactNativeFactoryProvider")) return next;
		// 模板一变就让 prebuild 失败，而不是悄悄生成一个启动即崩的包。
		if (!source.includes(DECLARATION) || !WINDOW_BLOCK.test(source)) throw new Error("with-scene-lifecycle: AppDelegate 模板变了，检查 ExpoAppSceneDelegate 的接法");
		source = source.replace(DECLARATION, "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
		// 窗口改由场景代理创建并启动 React Native；这里再建一个，就是一个没有场景的孤儿窗口外加第二个实例。
		source = source.replace(WINDOW_BLOCK, "\n");
		next.modResults.contents = source;
		return next;
	});
};
