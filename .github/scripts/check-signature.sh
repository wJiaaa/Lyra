#!/usr/bin/env bash
#
# What the artifact will actually claim to be, read back off the bundle.
#
# The failure this catches is silent by nature: a certificate that did not import, or an identity
# that did not match, leaves a perfectly working ad-hoc build — and nobody finds out until the
# release is installed and the permissions are gone. `cdhash` in the requirement is the tell.
#
# See `packages/desktop/electron-builder.yml` for why a certificate-bound identity is what makes an
# update the same application rather than a stranger.

set -euo pipefail

APPS=$(find packages/desktop/release -maxdepth 2 -name 'Plume.app')
if [ -z "$APPS" ]; then
	echo "::error::no Plume.app in the release output"
	exit 1
fi

# Every architecture: arm64 and x64 are signed in separate passes, and one of them going ad-hoc
# would only reset permissions on that kind of Mac.
while IFS= read -r APP; do
	REQUIREMENT=$(codesign -d -r- "$APP" 2>&1 | tail -1)
	echo "$APP: $REQUIREMENT"

	case "$REQUIREMENT" in
		*"certificate leaf"*)
			echo "signed with a durable identity: updates keep their permissions"
			;;
		*cdhash*)
			# Ad-hoc. Whether that is a failure depends on whether a certificate was supposed to be here.
			if [ "${REQUIRE_SIGNING:-false}" = "true" ] || [ "${HAVE_CERT:-false}" = "true" ]; then
				echo "::error::ad-hoc signed despite a certificate being present — the import or the identity name is wrong, and this build would reset every permission"
				exit 1
			fi
			echo "::warning::ad-hoc signed, as expected without a certificate"
			;;
		*)
			echo "::error::unrecognised designated requirement — refusing to ship a build whose identity cannot be read"
			exit 1
			;;
	esac
done <<< "$APPS"
