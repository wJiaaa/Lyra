# 手机端怎么打包

这个仓库没有 CI 和发版流水线（见 AGENTS.md 的「发版」），手机端的安装包和桌面端一样在本地打。
上游 kittors/Lyra 用两个 runner 在 tag 上构建 APK 与未签名的 IPA，这里只保留了它们在本地同样
成立的部分。

## 仓库里没有 android/ 和 ios/

`app.json` 是手机端唯一的描述。Gradle 文件、Xcode 工程、Podfile、图标、权限文案，全部由
`expo prebuild` 在构建时生成，构建完就丢掉（`packages/mobile/.gitignore` 里的 `/android`
和 `/ios`）。

这带来一个后果，值得写下来：**`app.json` 改一行就是改两个原生工程**，仓库里不存在第二份会跟它
唱反调的描述；反过来，凡是 prebuild 才会报出来的问题——插件不再接受某个参数、权限文案格式变了、
SDK 升级换了 Gradle 版本——在 lint、typecheck、单元测试里全是绿的。改了 `app.json` 或升级了 Expo，
就在本地把原生构建跑一遍，和改了打包配置要跑 `pnpm package` 是同一个道理。

## Android：签名钥匙是一次性的决定

`expo prebuild` 生成的 `android/app/build.gradle` 沿用 React Native 模板，而模板把 **release
构建类型指向 debug 的 keystore**：

```gradle
signingConfigs { debug { storeFile file('debug.keystore') storePassword 'android' … } }
buildTypes { release { … signingConfig signingConfigs.debug } }
```

所以裸仓库上 `assembleRelease` 出来的 APK 是能装的——这正是陷阱所在。Android 用签名证书判断
「这是不是同一个应用」：用模板那把 debug key 签出去的包，以后任何一个正经签名的版本都更新不了
它，用户必须先卸载，配对跟着一起丢。而那把钥匙是公开的，它就在模板里，拿到它的人能造出手机会
接受的「更新」。

要发给别人装的 APK，先用 `packages/mobile/scripts/make-release-keystore.sh` 生成一把自己的钥匙
（写到仓库根的 `signing/`，已被忽略），然后在打包时把它交给 Gradle。钥匙本体和密码只该在密码
管理器里——丢了它，所有装过的人都停在最后一个版本。

### 构建号：算出来，写进 app.json

不写的话，prebuild 就给 `versionCode 1`、`CFBundleVersion 1`。而 Android 拒绝安装 versionCode
不高于已装版本的包——每个版本都带 1，等于任何版本都更新不了任何版本，而且它不会说为什么。

数字由根 `package.json` 的版本号算出来：`major * 1000000 + minor * 1000 + patch`（0.9.11 →
9011），实现在 `scripts/versions.mjs` 的 `buildNumber()`。算而不是各写一遍，是因为第二处的数字会
漂——`app.json` 的版本号曾在 0.1.0 上停了三十五个版本。

算完由 `pnpm release` 写进 `app.json` 的 `android.versionCode` 与 `ios.buildNumber`，
`test/version-sync.test.ts` 守着它跟版本号对得上。**不走 Gradle property**：上游在真 runner 上试过
`-Pandroid.injected.version.code=9011`，Gradle 一声不吭地接受，构建绿，出来的 APK 带着
`versionCode 1`。property 的失败方式就是被忽略。

签名仍然只能走 property（`android.injected.signing.*`），失败方式同理——静静地退回 debug 签名，
看起来跟成功一模一样。所以打完包要把 APK 读回来确认（见下一节最后两行）。

## iOS：不签名

签名装到别人手机上需要 Apple Developer 账号：一年 $99，不走 TestFlight 的话还得提前登记设备
UDID。自己用的话，Xcode 用免费 Apple ID 直接装到连着的那台手机上就够了；要给别人，就打未签名的
归档，由装它的人用 Sideloadly、AltStore 或 Xcode 的 Devices 窗口自己签。

## 本地怎么打

`--no-install` 是必须的：prebuild 自带的安装步骤会在 pnpm workspace 里去找 npm，把
`node_modules` 在所有人脚下重排一遍。

iOS（需要 Xcode 与 CocoaPods）：

```bash
cd packages/mobile && pnpm exec expo prebuild --platform ios --no-install
cd ios && pod install && open *.xcworkspace
```

在 Xcode 里选自己的 Team 后直接 Run 到手机上，或 Product → Archive。scheme 要选工程里那个（名字
不是 slug）——workspace 会把 CocoaPods 塞进去的每个 scheme 一起列出来，选到 `EXConstants` 之类的
会归档成功、然后找不到 `.app`。

Android（需要 Android SDK 与一个已装的 NDK）：

```bash
cd packages/mobile && pnpm exec expo prebuild --platform android --no-install
cd android
PLUME_NDK_VERSION=$(basename "$(ls -d "$ANDROID_HOME"/ndk/* | tail -1)") \
  ./gradlew assembleRelease -I ../scripts/use-installed-ndk.init.gradle \
  -Pandroid.injected.signing.store.file="$PWD/../../../signing/plume-release.keystore" \
  -Pandroid.injected.signing.store.password="$PASSWORD" \
  -Pandroid.injected.signing.key.alias=plume \
  -Pandroid.injected.signing.key.password="$PASSWORD"

"$ANDROID_HOME"/build-tools/*/aapt2 dump badging app/build/outputs/apk/release/app-release.apk | head -1
"$ANDROID_HOME"/build-tools/*/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

`$PASSWORD` 是生成钥匙时打印的那个，从密码管理器里取，别写进 shell 历史以外的任何文件。最后两行
是读回确认：`versionCode` 应等于 `app.json` 里的构建号，证书应是 `CN=Plume`，而不是
`CN=Android Debug`。只给自己装、不在意以后的更新时，可以省掉四个签名参数。

那个 init script 是必须的，原因在它自己的注释里：Expo 点名要 NDK `27.1.12297006` 这一个修订号，
而本机装的通常不是这一个。缺了它 Gradle 不会报错，它会在配置阶段刷几分钟「Still waiting for
package manifests to be fetched remotely」（这句话里没有 NDK 三个字母），然后自己接受许可、
下载 1.5 GB。上游实测是八分钟之后才说出「Install NDK」。

## 没有覆盖的

没有任何东西会自动构建手机端，也不上 Play 或 TestFlight。「构建得出来」和「装上去能用」是两件事，
后者仍然是实机验收，见 `mobile-sync.md` 末尾那几段的口径。
