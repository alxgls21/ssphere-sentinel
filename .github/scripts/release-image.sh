#!/usr/bin/env bash
# Builds and pushes one image of a release (.github/workflows/release.yml), for linux/amd64, tagged with the
# release's version only, with the provenance and the SBOM BuildKit records; the moving tags (X.Y, latest)
# come after the release has been tested. Prints, for $GITHUB_OUTPUT, the image's name, its digest and
# both together (name@digest).
#
#   release-image.sh <image name> <context> [docker buildx build options...]
#
# Needs VERSION, GITHUB_REPOSITORY_OWNER, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_SHA and GITHUB_OUTPUT
# (set by GitHub Actions), a buildx builder that can export attestations, and a login to ghcr.io.
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: release-image.sh <image name> <context> [build options...]" >&2; exit 2; }
image_name=$1 context=$2
shift 2
: "${VERSION:?}" "${GITHUB_REPOSITORY_OWNER:?}" "${GITHUB_OUTPUT:?}"

owner=$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
name="ghcr.io/$owner/$image_name"
source="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT

annotations=()
for value in "org.opencontainers.image.source=$source" "org.opencontainers.image.revision=$GITHUB_SHA" \
    "org.opencontainers.image.version=$VERSION" "org.opencontainers.image.licenses=AGPL-3.0" \
    "org.opencontainers.image.title=$image_name"; do
    annotations+=(--label "$value" --annotation "index,manifest:$value")
done

docker buildx build "$context" "$@" \
    --platform linux/amd64 \
    --tag "$name:$VERSION" \
    "${annotations[@]}" \
    --provenance mode=max \
    --sbom true \
    --metadata-file "$metadata" \
    --push

digest=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$metadata")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "release-image: no digest for $name" >&2; exit 1; }
echo "$name@$digest"
{
    echo "name=$name"
    echo "digest=$digest"
    echo "image=$name@$digest"
} >> "$GITHUB_OUTPUT"
