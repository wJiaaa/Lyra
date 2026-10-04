#!/usr/bin/env bash
#
# The one key every Android release is signed with.
#
# Android decides whether two APKs are "the same app" by their signing certificate. Change the key
# and the phone refuses the update: the user has to uninstall, which takes their pairing with it.
# So this key is generated once, kept forever, and belongs in a password manager — losing it means
# every installed copy is stranded on its last version.
#
# 27 years of validity because Google Play requires at least 25 from the upload key, and because a
# key that expires is a release that stops being possible on a date nobody wrote down.
#
# Run it once:
#
#     bash packages/mobile/scripts/make-release-keystore.sh
#
# It writes nothing into the repository — `signing/` is ignored. The password is printed once, for
# the password manager; docs/architecture/mobile-packaging.md shows how a local build uses both.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
OUT="$ROOT/signing/plume-release.keystore"
ALIAS=plume

if [ -f "$OUT" ]; then
	echo "已经有一个了：$OUT"
	echo "别覆盖它——换一把钥匙等于让所有装过的人先卸载。要看它的内容：keytool -list -v -keystore $OUT"
	exit 1
fi

# Hex, not base64, and not something a person typed.
#
# The password travels through Gradle `-P` properties and `.properties` files, where a backslash is an
# escape character: a password containing one arrives at Gradle as a different password, and the build
# fails in the packaging task with a message about a keystore. Hex has no such character.
PASSWORD=$(openssl rand -hex 24)

mkdir -p "$(dirname "$OUT")"
keytool -genkeypair \
	-keystore "$OUT" \
	-storetype PKCS12 \
	-alias "$ALIAS" \
	-keyalg RSA -keysize 4096 \
	-validity 9999 \
	-storepass "$PASSWORD" \
	-keypass "$PASSWORD" \
	-dname "CN=Plume, OU=Plume, O=Plume, C=CN"

echo
echo "写好了：$OUT"
echo "把它备份到密码管理器里。仓库里不会有第二份，`signing/` 在 .gitignore 里。"
echo
echo "别名：$ALIAS"
echo "密码（store 与 key 同一个）：$PASSWORD"
echo
echo "本地打 release APK 时把它们作为 android.injected.signing.* 传给 Gradle，"
echo "见 docs/architecture/mobile-packaging.md 的「本地怎么打」。"
