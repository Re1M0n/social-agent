#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Smoke test del Social Agent en un servidor dedicado (ejecutar en el
# servidor, dentro de ~/apps/social-agent).
#   - Comprueba disco/RAM y que Ollama responde con el modelo.
#   - Ejecuta el pipeline completo en seco (ingest → generate → publish).
# ─────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

echo "═══ Smoke test — servidor dedicado ═══"
echo "Disco /mnt/storage:"
df -h /mnt/storage | tail -1
echo "RAM:"
free -h | head -2

echo ""
echo "── Ollama ──"
if curl -sf --max-time 5 http://localhost:11434/api/tags >/dev/null; then
  echo "✔ API de Ollama responde en localhost:11434"
  curl -s http://localhost:11434/api/tags | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).models||[];console.log('  Modelos disponibles:',m.length?m.map(x=>x.name).join(', '):'NINGUNO (ejecuta ollama pull)')})"
else
  echo "✘ Ollama no responde. Ejecuta: ~/ollama/ollama-user.sh start"
  exit 1
fi

echo ""
echo "── Pipeline (DRY_RUN) ──"
node dist/cli.js status | head -1

echo "→ ingest"
node dist/cli.js ingest

echo "→ generate (usa el LLM de Ollama; el primer post tarda más)"
START=$(date +%s)
node dist/cli.js generate
echo "  generate tardó $(( $(date +%s) - START ))s"

echo "→ publish --force (simulación)"
node dist/cli.js publish --force | head -2

echo "→ status"
node dist/cli.js status | head -1

echo ""
echo "═══ FIN. Todo en seco: nada se publicó de verdad (DRY_RUN=1). ═══"
