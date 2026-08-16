# 🧪 Test del Social Agent en un servidor dedicado

Guía para correr el pipeline completo (ingesta → agente LLM → drafts →
publicación en seco) en **un servidor Linux potente**, con **Ollama local**
y los modelos guardados en **`/mnt/storage`** (no en el disco del sistema).

Probado sobre Ubuntu 24.04, pero vale para cualquier Linux con Node 18+.
No requiere root: Ollama se instala en el espacio de usuario (`~/ollama`).

## Requisitos del hardware

El LLM local es el único componente que pide recursos. El mínimo que
funciona y lo recomendable:

| Escenario | CPU | RAM | Velocidad aprox. | Modelo recomendado |
|---|---|---|---|---|
| Mínimo (funciona, lento) | 2-4 vCPU | 8 GB | ~2-3 tok/s | `llama3.2:3b` o `gemma3:4b` |
| Medio (sin GPU) | 8+ vCPU | 16-32 GB | ~5-15 tok/s | `llama3.1:8b`, `qwen2.5:14b` |
| **Recomendado (con GPU)** | NVIDIA ≥ 8 GB VRAM | 16+ GB | 50-200+ tok/s | `llama3.1:8b` (o 14B con más VRAM) |

- Un modelo **8B con GPU** genera los 7 posts de un ítem en **~30 s** (frente
  a 5-7 min en CPU). El streaming SSE del cliente ya está implementado, así
  que no hay límites de tiempo de conexión.
- Con 70+ GB VRAM se puede correr `llama3.3:70b-q4_0`, calidad de nivel
  producción, sin depender de ninguna API externa.
- Si el servidor tiene GPU NVIDIA, instala los drivers y el runtime CUDA
  **antes** de arrancar Ollama (Ollama lo detecta solo; `ollama status` lo
  confirma mostrando el modelo con sufijo `(gpu)`).

## Despliegue en 5 pasos

```bash
# 1) Sube el proyecto (desde tu máquina)
rsync -av --exclude node_modules --exclude dist --exclude data ./ usuario@servidor:~/apps/social-agent/

# 2) Entra al servidor
ssh usuario@servidor
cd ~/apps/social-agent

# 3) Ollama en espacio de usuario (sin root), modelos en /mnt/storage
cp deploy/ollama-user.sh ~/ollama-user.sh
chmod +x ~/ollama-user.sh
~/ollama-user.sh install        # descarga el binario (~2 GB) a ~/ollama
~/ollama-user.sh start          # arranca con OLLAMA_MODELS=/mnt/storage/ollama
~/ollama-user.sh pull           # descarga llama3.1:8b a /mnt/storage/ollama (~5 GB)
~/ollama-user.sh status         # verifica: en marcha + modelo listo

# 4) Configura y compila
cp deploy/server.env .env       # DRY_RUN=1, LLM local, 7 canales
npm ci && npm run build

# 5) Smoke test completo en seco
./smoke-test.sh
```

Comprueba antes que `/mnt/storage` es escribible por tu usuario y que tiene
**≥ 10 GB libres** (`df -h /mnt/storage`). Si el disco se llama distinto,
ajusta `OLLAMA_MODELS_DIR` al instalar (p. ej. `OLLAMA_MODELS_DIR=/data/ollama
~/ollama-user.sh install`).

## Comandos útiles

```bash
~/ollama-user.sh status     # ¿Ollama en marcha? ¿qué modelos hay?
~/ollama-user.sh start      # arrancar (si no está)
~/ollama-user.sh stop       # parar
cd ~/apps/social-agent

node dist/cli.js status     # estado de la cola
node dist/cli.js ingest     # detectar ideas/media nuevos
node dist/cli.js generate   # el agente genera drafts (usando Ollama)
node dist/cli.js publish --force   # publica en seco (DRY_RUN=1)
./smoke-test.sh             # todo el pipeline de una vez
```

## Modelo LLM

- Por defecto: **`llama3.1:8b`** (buen equilibrio calidad/recursos). Cámbialo
  en `.env` con `LLM_MODEL` según la tabla de arriba.
- Los modelos viven en **`/mnt/storage/ollama`**: sobreviven a reinicios y
  actualizaciones del sistema; el disco del servidor solo guarda el binario
  (~2 GB) y la app.
- **Alternativa sin disco ni GPU**: una API gratuita en la nube (OpenRouter
  `:free`, Groq, Gemini — ver `docs/llm-disk-space.md`). Responde en segundos
  y ocupa 0 MB; solo cambia `LLM_BASE_URL`/`LLM_MODEL` en `.env`.

## Verificación del test

El smoke test deja su resultado en `~/apps/social-agent/smoke.log`. Criterios
de éxito:

1. `ingest` detecta los 4 ítems de ejemplo.
2. `generate` crea drafts — **al menos uno generado por el LLM de Ollama**
   (los fallos transitorios se recuperan solos con el reintento con backoff).
3. `publish --force` marca todo como `published` (dry-run).
4. `status` muestra `4 ítems | 28 drafts | 28 publicados`.

## Pasar a publicación real (más adelante)

En `~/apps/social-agent/.env`:
```bash
DRY_RUN=0                        # ojo: publica de verdad
# + rellena las credenciales de los canales que quieras usar
# (MASTODON_TOKEN, BLUESKY_APP_PASSWORD, etc.)
```
Recomendación: empieza con 1-2 canales y verifica manualmente los posts.

## Problemas conocidos y soluciones

- **Ollama no responde** → `~/ollama-user.sh start` (los modelos sobreviven
  en `/mnt/storage` aunque se reinicie el servidor).
- **La GPU no se usa** → verifica drivers CUDA y que el proceso `ollama`
  arrancó *después* de instalar los drivers. `ollama status` muestra
  `(gpu)` junto al modelo si la detección funciona.
- **"LLM falló (fetch failed)"** → fallo transitorio (arranque del modelo,
  red). Con el reintento con backoff se recupera automáticamente; si
  persiste, `~/ollama-user.sh status` y revisa `~/ollama/ollama.log`.
- **generate muy lento** → si no hay GPU, bájate a 1-2 canales en `.env`
  (`CHANNEL_*_ENABLED=0`) para pruebas rápidas, o usa una API gratuita.
