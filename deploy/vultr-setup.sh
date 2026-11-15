#!/usr/bin/env bash
# One-command setup of the DysphaGrip public demo on a fresh Ubuntu 24.04 server (e.g. Vultr Cloud Compute).
#   ssh root@SERVER_IP
#   curl -fsSL https://raw.githubusercontent.com/XxPosedd/dysphagrip/main/deploy/vultr-setup.sh -o setup.sh && bash setup.sh
#
# - Asks for the Neon DATABASE_URL and ElevenLabs key/voice (hidden input); stores them ONLY in /opt/dysphagrip.env (mode 600).
# - Runs the dashboard + API in Docker in READ-ONLY demo mode (visitors cannot save/delete sessions).
# - Serves HTTPS via Caddy on a free sslip.io name derived from the server IP (no domain, no personal data).
# Re-running it updates the code and restarts the container; existing settings are kept.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (or with sudo)."; exit 1; }

IP="$(hostname -I | awk '{print $1}')"
HOST="${IP//./-}.sslip.io"
ENV_FILE=/opt/dysphagrip.env
APP_DIR=/opt/dysphagrip
echo "== DysphaGrip setup: server ${IP} -> https://${HOST}"

echo "== 1/6 swap (lets the build fit in 1 GB RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 2/6 Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "== 3/6 code"
if [ -d "${APP_DIR}/.git" ]; then git -C "${APP_DIR}" pull --ff-only; else git clone https://github.com/XxPosedd/dysphagrip.git "${APP_DIR}"; fi

echo "== 4/6 settings"
if [ ! -s "${ENV_FILE}" ]; then
  echo "Paste values from your local .env. Input is hidden; nothing is printed or sent anywhere except this file."
  echo "Paste with RIGHT-CLICK (do not press Ctrl+Z). Surrounding quotes are removed automatically."
  # Strip whitespace and one pair of surrounding quotes ("..." or '...'), as found in .env files.
  clean() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; v="${v#[\"\']}"; v="${v%[\"\']}"; printf '%s' "$v"; }
  while :; do
    read -rsp "  DATABASE_URL (Neon, pooled): " DB </dev/tty; echo; DB="$(clean "$DB")"
    if [[ "$DB" =~ ^postgres(ql)?://[^[:space:]\"\']+$ ]]; then break; fi
    echo "  That doesn't look like a single postgres:// URL (no spaces or quotes). Please paste just the URL again."
  done
  while :; do
    read -rsp "  ELEVENLABS_API_KEY: " ELK </dev/tty; echo; ELK="$(clean "$ELK")"
    if [[ -n "$ELK" && ! "$ELK" =~ [[:space:]] ]]; then break; fi
    echo "  Empty or contains spaces. Please paste just the key again."
  done
  while :; do
    read -rp "  ELEVENLABS_VOICE_ID: " ELV </dev/tty; ELV="$(clean "$ELV")"
    if [[ "$ELV" =~ ^[A-Za-z0-9]+$ ]]; then break; fi
    echo "  A voice ID is letters and digits only. Please paste it again."
  done
  ( umask 077; printf 'NODE_ENV=production\nPORT=3000\nDEMO_READ_ONLY=true\nDATABASE_URL=%s\nELEVENLABS_API_KEY=%s\nELEVENLABS_VOICE_ID=%s\n' \
      "${DB}" "${ELK}" "${ELV}" > "${ENV_FILE}" )
  unset DB ELK ELV
else
  echo "  keeping existing ${ENV_FILE}"
fi

echo "== 5/6 build and start (a few minutes on a small server)"
cd "${APP_DIR}"
docker build -t dysphagrip .
docker rm -f dysphagrip >/dev/null 2>&1 || true
docker run -d --name dysphagrip --restart unless-stopped --env-file "${ENV_FILE}" -p 127.0.0.1:3000:3000 dysphagrip >/dev/null
for _ in $(seq 1 40); do curl -fs localhost:3000/api/health >/dev/null && break; sleep 1; done
echo "  health: $(curl -fs localhost:3000/api/health || echo 'NOT RESPONDING - see: docker logs dysphagrip')"

echo "== 6/6 HTTPS (Caddy) and firewall"
command -v caddy >/dev/null || { apt-get update -qq && apt-get install -y -qq caddy; }
printf '%s {\n    reverse_proxy 127.0.0.1:3000\n}\n' "${HOST}" > /etc/caddy/Caddyfile
systemctl restart caddy
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
fi

echo
echo "DONE  ->  https://${HOST}   (the certificate can take about a minute on first visit)"
echo "Logs: docker logs -f dysphagrip     Update later: bash setup.sh"
