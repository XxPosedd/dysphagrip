#!/bin/sh
# Runs as root on a Vultr Ubuntu 24.04 VM, after the SSH client unpacks the release.
set -eu
umask 077
stage=$1
root=/opt/dysphagrip
revision=$(cat "$stage/revision")
export SETTINGS_DIR="$root/settings"
export RELEASE_COMMIT="$revision"
install -d -m 700 "$root" "$root/releases" "$SETTINGS_DIR" "$SETTINGS_DIR/voice"
exec 9>"$root/deploy.lock"
flock -x 9

if ! docker compose version >/dev/null 2>&1; then
    . /etc/os-release
    if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ]; then
        echo "Install Docker Engine and Compose v2, or use an Ubuntu 24.04 VM." >&2
        exit 1
    fi
    apt-get -q update
    DEBIAN_FRONTEND=noninteractive apt-get -qy install docker.io docker-compose-v2 docker-buildx
fi
systemctl enable --now docker

release="$root/releases/$revision"
if [ ! -d "$release" ]; then
    # Copy to the target filesystem before atomically publishing this release.
    pending=$(mktemp -d "$root/releases/.incoming.XXXXXX")
    trap 'rm -rf -- "$pending"' EXIT
    cp -R "$stage/app/." "$pending"
    mv "$pending" "$release"
fi
cd "$release"
compose() { docker compose -p dysphagrip -f deploy/compose.yaml "$@"; }
touch "$SETTINGS_DIR/brightdata.env"
compose build app
if [ -f "$stage/brightdata.env" ]; then
    install -m 600 "$stage/brightdata.env" "$SETTINGS_DIR/brightdata.env"
fi
if [ -d "$stage/voice" ]; then
    for phrase in started stopped; do
        install -m 600 "$stage/voice/$phrase.mp3" "$SETTINGS_DIR/voice/.$phrase.mp3"
        mv "$SETTINGS_DIR/voice/.$phrase.mp3" "$SETTINGS_DIR/voice/$phrase.mp3"
    done
fi
if [ -f "$SETTINGS_DIR/voice/started.mp3" ] && [ -f "$SETTINGS_DIR/voice/stopped.mp3" ]; then
    VOICE_REVISION=$(sha256sum "$SETTINGS_DIR"/voice/*.mp3 | sha256sum | cut -d ' ' -f 1)
    export VOICE_REVISION
fi
if [ -f "$stage/site-address" ]; then
    install -m 600 "$stage/site-address" "$SETTINGS_DIR/site-address"
fi
SITE_ADDRESS=:80
if [ -f "$SETTINGS_DIR/site-address" ]; then SITE_ADDRESS=$(cat "$SETTINGS_DIR/site-address"); fi
export SITE_ADDRESS
compose up -d --wait --wait-timeout 120
ln -sfn "$release" "$root/.next"
mv -Tf "$root/.next" "$root/current"
if [ "$SITE_ADDRESS" = ":80" ]; then
    curl -fsS --retry 8 --retry-connrefused http://127.0.0.1/api/health
else
    curl -fsS --retry 10 --retry-all-errors --retry-max-time 90 --resolve "$SITE_ADDRESS:443:127.0.0.1" "https://$SITE_ADDRESS/api/health"
fi
printf '\nDeployed %s\n' "$revision"
