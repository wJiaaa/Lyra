#!/bin/bash
#
# A signing identity that survives updates, without an Apple Developer account.
#
# The problem this solves: macOS decides whether two builds are "the same app" by their designated
# requirement, and for an ad-hoc signed app (`identity: "-"`) that requirement is a hash of the
# executable:
#
#     designated => cdhash H"ff1c876598ea614d4bc7fead3bb1c0d9c2c710a7"
#
# Every release changes the binary, so every release is a different application as far as the
# system is concerned — screen recording permission is revoked, keychain entries stop opening, and
# the user is asked to authorise everything again. Signing with *any* certificate changes the
# requirement to name the certificate instead:
#
#     designated => identifier "dev.plume.app" and certificate leaf = H"<this cert>"
#
# which does not mention the executable at all. Verified by signing two completely different
# binaries with one certificate and diffing the requirement: identical.
#
# The certificate does not have to come from Apple. It cannot be notarised — that needs the paid
# account — so a download from a browser still meets Gatekeeper's "unidentified developer" prompt
# on FIRST install. Updates do not: they are applied by replacing the bundle in place, which never
# carries a quarantine flag. So the prompt is once, ever, instead of the permissions being reset
# every time.
#
# Usage:
#
#     ./make-signing-cert.sh                  # writes ./signing/ and prints what to do next
#     ./make-signing-cert.sh /some/other/dir
#
# What comes out: a .p12 to put in GitHub Secrets, its base64 for the same, and the certificate's
# name for `mac.identity`. The private key stays wherever you ran this — do not commit it.

set -euo pipefail

#
# Outside the repository by default, not merely git-ignored inside it.
#
# An ignore rule is a promise that holds until someone checks out a branch written before the rule
# existed, or runs `git add -f`, or copies the tree somewhere. This is the private key every
# release is signed with and that every granted permission is tied to; "probably not committed" is
# the wrong guarantee for it. Somewhere git has no opinion about is the right one.
#
OUT="${1:-$HOME/.plume-signing}"
NAME="Plume Code Signing"

# Twenty years. The certificate's fingerprint *is* the app's identity, so replacing it resets every
# permission exactly the way the current problem does — an expiry is a scheduled recurrence of the
# bug. Self-signed certificates have no revocation story anyway, so a short life buys nothing.
DAYS=7300

if [ -e "$OUT" ]; then
	echo "refusing to overwrite $OUT — move it aside first" >&2
	echo "(replacing the certificate resets every permission the old one held)" >&2
	exit 1
fi

mkdir -p "$OUT"
chmod 700 "$OUT"

read -r -s -p "Password to protect the .p12 with: " PASSWORD
echo
if [ -z "$PASSWORD" ]; then
	echo "a password is required: this file is the signing identity" >&2
	exit 1
fi

cat > "$OUT/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = $NAME

[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
# Without this codesign will not accept the certificate at all.
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
	-keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/openssl.cnf" 2>/dev/null

#
# `-legacy` is load-bearing.
#
# OpenSSL 3 defaults to AES-256-CBC with a SHA-256 MAC, and macOS's Security framework cannot read
# it — `security import` fails with "MAC verification failed during PKCS12 import (wrong
# password?)", which sends you looking for a typo in a password that is correct.
#
openssl pkcs12 -export -legacy \
	-inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
	-out "$OUT/certificate.p12" -passout "pass:$PASSWORD" -name "$NAME" 2>/dev/null

base64 -i "$OUT/certificate.p12" -o "$OUT/certificate.p12.base64"
chmod 600 "$OUT"/*

FINGERPRINT=$(openssl x509 -in "$OUT/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')

cat <<EOF

Done. Everything is in $OUT (0600, and already ignored by git).

  certificate.p12          the signing identity
  certificate.p12.base64   the same, for the secret below
  key.pem / cert.pem       the parts it was built from
  fingerprint              $FINGERPRINT

Put two secrets in GitHub — Settings › Secrets and variables › Actions:

  MAC_CERTIFICATE_P12       $OUT/certificate.p12.base64   (paste the file's contents)
  MAC_CERTIFICATE_PASSWORD  the password you just typed

Then keep $OUT somewhere safe and out of the repository. Losing it is not fatal — you can generate
another — but the replacement is a different identity, so every permission granted to builds signed
with this one is reset once more. Treat it the way you would the login it protects.

That is all that is needed: the next tag signs itself.

---

To sign locally, install the identity into your own keychain once:

  security import $OUT/certificate.p12 -k ~/Library/Keychains/login.keychain-db \\
    -P '<the password>' -T /usr/bin/codesign
  security add-trusted-cert -r trustRoot $OUT/cert.pem

\`pnpm --filter @plume/desktop package\` then finds it by name and signs with it — it looks the
identity up rather than taking a path, because electron-builder's own \`CSC_LINK\` import is broken
in 26.15.3 (it unlocks its temporary keychain with the certificate's password instead of the
keychain's). See scripts/package.mjs.

To check any build carries the durable identity rather than a hash:

  codesign -d -r- packages/desktop/release/mac*/Plume.app
  # want: identifier "dev.plume.app" and certificate leaf = H"..."
  # not:  cdhash H"..."     <- ad-hoc; permissions reset on every update
EOF
