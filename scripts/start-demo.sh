#!/usr/bin/env bash
# Start the whole DysphaGrip demo in ONE terminal: the Python audio/motion service plus the API and dashboard.
#   bash scripts/start-demo.sh        -> open http://localhost:5173      (Ctrl+C stops everything)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env found. Run: bash scripts/setup-demo.sh"; exit 1; }
if [ -x services/audio/.venv/bin/python ]; then VPY=services/audio/.venv/bin/python
elif [ -x services/audio/.venv/Scripts/python.exe ]; then VPY=services/audio/.venv/Scripts/python.exe
else echo "Python environment missing. Run: bash scripts/setup-demo.sh"; exit 1; fi

for port in 3000 5173 8765; do
  if (echo >"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    echo "Port ${port} is already in use: DysphaGrip may already be running (or close the program using it)."; exit 1
  fi
done

pids=()
cleanup() {
  echo; echo "Stopping DysphaGrip..."
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== starting audio + motion service (port 8765)"
( cd services/audio && exec "../../${VPY}" -m dysphagrip_audio serve ) & pids+=($!)
echo "== starting API (port 3000) and dashboard (port 5173)"
npm run dev & pids+=($!)

for _ in $(seq 1 60); do
  if (echo >/dev/tcp/127.0.0.1/5173) 2>/dev/null && (echo >/dev/tcp/127.0.0.1/8765) 2>/dev/null; then break; fi
  sleep 1
done
echo
echo "READY  ->  http://localhost:5173      (signal lab: http://localhost:5173/?view=lab)"
echo "Press Ctrl+C here to stop everything."
command -v open >/dev/null && open http://localhost:5173 2>/dev/null || true
wait
