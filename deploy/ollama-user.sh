#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Ollama en espacio de usuario (sin root) con modelos en /mnt/storage.
# Sirve para cualquier servidor Linux; no necesita sudo.
#
# Uso:  ./ollama-user.sh {install|start|stop|pull|status}
# Env:  OLLAMA_HOME       (por defecto ~/ollama)
#       OLLAMA_MODELS_DIR (por defecto /mnt/storage/ollama)
#       OLLAMA_MODEL      (por defecto llama3.1:8b; con GPU/32 GB+ RAM
#                          prueba llama3.3:70b-q4_0 o qwen2.5:14b)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

OLLAMA_HOME="${OLLAMA_HOME:-$HOME/ollama}"
OLLAMA_MODELS_DIR="${OLLAMA_MODELS_DIR:-/mnt/storage/ollama}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
BIN="$OLLAMA_HOME/bin/ollama"
PIDFILE="$OLLAMA_HOME/ollama.pid"
LOGFILE="$OLLAMA_HOME/ollama.log"

cmd="${1:-status}"

case "$cmd" in
  install)
    mkdir -p "$OLLAMA_HOME" "$OLLAMA_MODELS_DIR"
    echo "▶ Descargando Ollama (binario Linux amd64)…"
    curl -fsSL https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst -o /tmp/ollama.tar.zst
    if tar --zstd -C "$OLLAMA_HOME" -xf /tmp/ollama.tar.zst 2>/dev/null; then
      :
    else
      # Fallback: descomprimir con zstd por separado.
      zstd -d -f /tmp/ollama.tar.zst -o /tmp/ollama.tar
      tar -C "$OLLAMA_HOME" -xf /tmp/ollama.tar
    fi
    rm -f /tmp/ollama.tar.zst /tmp/ollama.tar
    echo "✔ Ollama instalado en $OLLAMA_HOME"
    echo "  Modelos se guardarán en: $OLLAMA_MODELS_DIR"
    ;;

  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Ollama ya está en marcha (pid $(cat "$PIDFILE"))."
      exit 0
    fi
    mkdir -p "$OLLAMA_HOME" "$OLLAMA_MODELS_DIR"
    nohup env OLLAMA_MODELS="$OLLAMA_MODELS_DIR" "$BIN" serve >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "✔ Ollama arrancado (pid $!)"
    echo "  Modelos en: $OLLAMA_MODELS_DIR (log: $LOGFILE)"
    ;;

  stop)
    if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then
      rm -f "$PIDFILE"
      echo "✔ Ollama detenido."
    else
      echo "Ollama no estaba en marcha."
    fi
    ;;

  pull)
    mkdir -p "$OLLAMA_MODELS_DIR"
    echo "▶ Descargando modelo $OLLAMA_MODEL (esto puede tardar)…"
    env OLLAMA_MODELS="$OLLAMA_MODELS_DIR" "$BIN" pull "$OLLAMA_MODEL"
    echo "✔ Modelo $OLLAMA_MODEL listo."
    ;;

  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "✔ Ollama en marcha (pid $(cat "$PIDFILE"))."
      echo "  Directorio de modelos: $OLLAMA_MODELS_DIR"
      env OLLAMA_MODELS="$OLLAMA_MODELS_DIR" "$BIN" list 2>/dev/null || true
    else
      echo "✘ Ollama no está en marcha. Ejecuta: $0 start"
      exit 1
    fi
    ;;

  *)
    echo "Uso: $0 {install|start|stop|pull|status}"
    exit 1
    ;;
esac
