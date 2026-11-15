#!/usr/bin/env bash
# One-command setup of DysphaGrip on a demo laptop (macOS, Linux, or Windows via Git Bash).
#   git clone https://github.com/XxPosedd/dysphagrip.git && cd dysphagrip && bash scripts/setup-demo.sh
# Then start everything with:  bash scripts/start-demo.sh
#
# - Installs JavaScript and Python dependencies.
# - Creates .env and asks for the three keys (hidden input; surrounding quotes are removed). Keys stay on this laptop.
# - Lists audio inputs and serial ports so you can see the UM2 and the Arduino.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

say "1/5 checking tools"
command -v git >/dev/null || fail "git is not installed."
command -v node >/dev/null || fail "Node.js is not installed. Install Node 20+ from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 20 ] || fail "Node ${NODE_MAJOR} is too old. Install Node 20+ from https://nodejs.org."
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "${PY}" ] || fail "Python 3.10+ is not installed. Install it from https://python.org and re-run."
echo "node $(node -v), $(${PY} --version)"

say "2/5 JavaScript packages (1-3 minutes)"
npm install --no-audit --no-fund --loglevel=error
npm run install:all --silent

say "3/5 Python audio service"
cd services/audio
[ -d .venv ] || "${PY}" -m venv .venv
if [ -x .venv/bin/python ]; then VPY=.venv/bin/python; else VPY=.venv/Scripts/python.exe; fi
"${VPY}" -m pip install --quiet --upgrade pip
"${VPY}" -m pip install --quiet -r requirements.txt
cd ../..

say "4/5 keys (.env)"
clean() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; v="${v#[\"\']}"; v="${v%[\"\']}"; printf '%s' "$v"; }
has_value() { grep -Eq "^$1=.+" .env 2>/dev/null; }
[ -f .env ] || cp .env.example .env
set_env() {  # replace or append KEY=VALUE without printing the value
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" .env; then
    awk -v k="${key}" -v v="${val}" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > "${tmp}"
  else
    cat .env > "${tmp}"; printf '%s=%s\n' "${key}" "${val}" >> "${tmp}"
  fi
  mv "${tmp}" .env
}
if has_value DATABASE_URL && has_value ELEVENLABS_API_KEY && has_value ELEVENLABS_VOICE_ID; then
  echo "keeping keys already in .env"
else
  echo "Paste the values you were sent privately. Input is hidden; quotes are removed automatically."
  while :; do
    read -rsp "  DATABASE_URL (starts with postgresql://): " DB </dev/tty; echo; DB="$(clean "$DB")"
    [[ "$DB" =~ ^postgres(ql)?://[^[:space:]\"\']+$ ]] && break
    echo "  That isn't a single postgres:// URL. Paste just the URL again."
  done
  while :; do
    read -rsp "  ELEVENLABS_API_KEY: " ELK </dev/tty; echo; ELK="$(clean "$ELK")"
    [[ -n "$ELK" && ! "$ELK" =~ [[:space:]] ]] && break
    echo "  Empty or contains spaces. Paste just the key again."
  done
  while :; do
    read -rp "  ELEVENLABS_VOICE_ID: " ELV </dev/tty; ELV="$(clean "$ELV")"
    [[ "$ELV" =~ ^[A-Za-z0-9]+$ ]] && break
    echo "  A voice ID is letters and digits only. Paste it again."
  done
  set_env DATABASE_URL "$DB"; set_env ELEVENLABS_API_KEY "$ELK"; set_env ELEVENLABS_VOICE_ID "$ELV"
  unset DB ELK ELV
  chmod 600 .env 2>/dev/null || true
  echo "saved to .env (git-ignored; never commit it)"
fi

say "5/5 hardware check"
cd services/audio
echo "-- audio inputs (look for UM2 / USB Audio CODEC):"
"${VPY}" -m dysphagrip_audio devices || echo "(could not list audio devices)"
echo "-- serial ports (look for the Arduino UNO Q):"
"${VPY}" -m dysphagrip_audio motion-ports || echo "(no serial ports yet: plug in the UNO Q)"
cd ../..

cat <<'EOF'

DONE. Start everything with:
    bash scripts/start-demo.sh
then open http://localhost:5173

macOS: the first time the mic starts, allow microphone access for Terminal
(System Settings > Privacy & Security > Microphone). Without it the dashboard shows "No signal".
EOF
