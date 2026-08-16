# 🤖 Social Agent — Agente de marketing en redes sociales

![CI](https://github.com/Re1M0n/social-agent/actions/workflows/ci.yml/badge.svg)
![versión](https://img.shields.io/github/package-json/v/Re1M0n/social-agent)
![licencia](https://img.shields.io/github/license/Re1M0n/social-agent)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

Agente que **ingiere tus ideas base, fotos y videos**, los convierte en publicaciones
adaptadas a cada plataforma usando un **agente experto LLM** (estratega de marketing),
y **publica de forma autónoma en varios canales** (Mastodon, Bluesky, X, LinkedIn,
Instagram, Facebook y TikTok).

## Cómo funciona

```
content/ideas/*.md  ─┐
                     ├─► ingest ─► generate ─► schedule ─► publish ─► 🚀 canales
content/media/*     ─┘   (detecta)   (LLM por      (horarios    (API real
                                       plataforma)   óptimos)     por canal)
```

1. **Ingesta** — deja ideas en `content/ideas/` (archivos `.md`/`.txt`) y fotos/videos en `content/media/`. El agente los detecta al vuelo.
2. **Generación** — el agente experto convierte cada idea en **una publicación por plataforma**, con el tono, formato, hashtags y límites de caracteres de cada red. **Habla con la IA por defecto**: sin `LLM_API_KEY` detecta una **IA local** (Ollama/LM Studio, incluso en otra máquina con Qwen); si no hay, usa un proveedor gratuito anónimo (Kilo Code, sin registro) y, si falla, cae a plantillas de calidad decente. Comprueba la conexión con `npm run llm:check`.
3. **Programación** — en modo autónomo calcula el **mejor horario** para cada canal y respeta un intervalo mínimo anti-spam.
4. **Publicación** — sube la media (imagen/video) y publica en cada canal con su API oficial.

## Requisitos

- Node.js ≥ 22 (probado con Node 24)

## Instalación

```bash
npm install
cp .env.example .env    # rellena credenciales (abajo)
```

## Uso rápido

```bash
npm run ingest      # escanea content/ideas y content/media
npm run llm:check   # comprueba la conexión con la IA y el proveedor en uso
npm run generate    # genera drafts por plataforma (IA gratuita o plantillas)
npm run publish     # publica los posts programados
npm run serve       # 🤖 modo autónomo: vigila, genera, programa y publica solo
npm run status      # estado de la cola
npm run channels    # qué canales están configurados
```

### Ejemplo completo

```bash
# 1. Pon una idea en content/ideas/mi-idea.md y un video en content/media/

# 2. Ingiere y genera
npm run ingest && npm run generate

# 3. Revisa lo que generó (recomendado la primera vez)
npm run status

# 4. En vivo (cuando estés listo, quita DRY_RUN=1 del .env)
npm run publish -- --force

# 5. Automatización total: deja ideas/media y que publique solo
AUTO_PUBLISH=1 npm run serve
```

## Modo autónomo (`serve`)

```bash
AUTO_PUBLISH=1 DRY_RUN=0 npm run serve
```

- Vigila `content/ideas/` y `content/media/` en tiempo real.
- Cada archivo nuevo → ingesta → generación → programación en horario óptimo → publicación.
- Revisa cada 30s si hay posts programados que ya tocan.
- Con `AUTO_PUBLISH=0` (por defecto) solo **genera borradores** para que los revises antes.

## Configuración clave (`.env`)

| Variable | Descripción | Default |
|---|---|---|
| `DRY_RUN` | `1` = simulación (no publica nada), `0` = en vivo | `1` |
| `AUTO_PUBLISH` | `1` = publica solo, `0` = deja drafts para revisión | `0` |
| `MIN_POST_INTERVAL_MINUTES` | Intervalo mínimo entre publicaciones | `60` |
| `LLM_API_KEY` | Clave del LLM (OpenAI, OpenRouter, Groq, Ollama…) | — |
| `LLM_BASE_URL` | Endpoint compatible con Chat Completions | OpenAI |
| `LLM_MODEL` | Modelo a usar | `gpt-4o-mini` |
| `LLM_FREE_FALLBACK` | `1` = sin key usa el proveedor gratuito anónimo (Kilo); `0` = solo plantillas | `1` |
| `LLM_LOCAL` | `auto` = detecta IA local/remota (Ollama, LM Studio, Qwen); `1` = forzar; `0` = off | `auto` |
| `OLLAMA_BASE_URL` | Host de una máquina remota con Ollama (p. ej. con Qwen) | — |
| `OLLAMA_MODEL` | Modelo a usar en esa máquina (opcional: si no, elige el mejor) | — |
| `LLM_SPEED` | Selector de potencia/velocidad: `ahorro` \| `equilibrado` \| `rendimiento` | `equilibrado` |

### Credenciales por canal

| Canal | Variables | Cómo obtenerlas |
|---|---|---|
| **Mastodon** | `MASTODON_URL`, `MASTODON_TOKEN` | Preferencias → Desarrollo → Nueva aplicación |
| **Bluesky** | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | Configuración → App Passwords |
| **X/Twitter** | `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET` | Developer Portal (OAuth 1.0a) |
| **LinkedIn** | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORG_ID` (opcional) | OAuth2 con scope `w_member_social` |
| **Instagram** | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `INSTAGRAM_MEDIA_BASE_URL` | Meta Graph API; la media debe tener URL pública |
| **Facebook** | `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_PAGE_ID` | Meta Graph API (scope `pages_manage_posts`) |
| **TikTok** | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_OPEN_ID`, `TIKTOK_MEDIA_BASE_URL` | Content Posting API; el video debe tener URL pública |

> Un canal se habilita automáticamente cuando tiene credenciales, o explícitamente
> con `CHANNEL_<CANAL>_ENABLED=1` (por ejemplo `CHANNEL_TIKTOK_ENABLED=1`).

### 🤖 IA local o remota (Ollama, LM Studio, Qwen) — automática

Si tienes **Ollama** o **LM Studio** arrancados en tu máquina
(`localhost:11434` / `localhost:1234`), el agente los detecta **solo** y usa el
mejor modelo disponible (prefiere Qwen, Llama, Gemma, Mistral, DeepSeek, Phi…),
sin tocar el `.env`:

```bash
ollama pull qwen2.5:7b        # una sola vez (o el modelo que quieras)
npm run llm:check             # verás: IA ollama — modelo qwen2.5:7b
```

¿Tienes Qwen (u Ollama) en **otra máquina**? Apunta con `OLLAMA_BASE_URL`:

```bash
# .env
OLLAMA_BASE_URL=http://192.168.1.50:11434   # máquina con Qwen
OLLAMA_MODEL=qwen2.5:7b                     # opcional: si no, elige el mejor
```

- `LLM_LOCAL=auto` (por defecto): usa la IA local/remota si responde; si no,
  cae al proveedor gratuito anónimo (Kilo) y, si falla, a plantillas.
- `LLM_LOCAL=1`: fuerza la IA local (avisa si no responde).
- `LLM_LOCAL=0`: desactiva la detección (configuración manual con
  `LLM_BASE_URL`/`LLM_MODEL`, como antes).
- Con `LLM_API_KEY` configurada, la detección se ignora: manda tu proveedor.

### 🐢⚡ Selector de potencia/velocidad (cuidar el hardware)

Para **cuidar el hardware** de tu máquina con Qwen (temperatura, RAM/VRAM,
consumo), el agente habla con Ollama por su **API nativa** y ajusta según
`LLM_SPEED` (`ahorro` | `equilibrado` | `rendimiento`):

| Modo | Contexto | Máx. salida | Modelo en RAM | CPUs | Modelo elegido |
|---|---|---|---|---|---|
| **ahorro** 🐢 | 6144 | 2048 | se descarga a los 5 min | mitad | el más pequeño (p. ej. `qwen2.5:3b`) |
| **equilibrado** | 8192 | 3072 | se descarga a los 30 min | todas | según familia/versión |
| **rendimiento** ⚡ | 16384 | 4096 | siempre cargado | todas | el más grande (p. ej. `qwen2.5:14b`) |

```bash
# .env
LLM_SPEED=ahorro        # menos calor y consumo en la máquina de Qwen
```

`npm run llm:check` te muestra el modo activo. En modo ahorro se usa la mitad
de los hilos de CPU y se limita el contexto, así el modelo no trabaja de más
cuando no hace falta.

### 🔑 Verificación de credenciales en vivo

```bash
npm run credentials:check
```

Comprueba **en vivo** que las credenciales de Mastodon y Bluesky funcionan
(consulta la API real de la plataforma y muestra tu cuenta y seguidores). Los
canales sin API accesible (X, LinkedIn, Instagram, Facebook, TikTok) muestran
un aviso y usan `data/metrics-manual.json`. Ideal antes de activar `AUTO_PUBLISH`
o de publicar en vivo por primera vez.

## 📦 Media pública para Instagram y TikTok

Instagram y TikTok **no suben la media desde tu máquina**: sus servidores la
**descargan desde una URL** que tú les pasas. Por eso la media debe ser accesible
por HTTP. Los demás canales (Mastodon, Bluesky, X, LinkedIn, Facebook) suben la
media directamente y no necesitan nada de esto.

### 1. Sirve la carpeta de media (local)

```bash
npm run serve:media        # sirve content/media en http://localhost:8787 (con CORS)
```

### 2. Hazla accesible desde Internet

`localhost` solo sirve para probar: los servidores de Meta/TikTok no pueden
alcanzar tu máquina. Tienes que exponer la carpeta con una URL pública. Opciones:

- **ngrok** (más rápido para probar): `ngrok http 8787` → te da `https://xxxx.ngrok-free.app`
- **VPS / hosting estático**: sube `content/media/` a un hosting y usa su URL
- **CDN / bucket**: S3, Cloudflare R2, etc.

> ⚠️ Si usas ngrok en modo free, la URL cambia en cada reinicio: actualiza
> `PUBLIC_MEDIA_BASE_URL` y regenera los drafts antes de publicar.

### 3. Configura la base URL en `.env`

```bash
# En .env:
PUBLIC_MEDIA_BASE_URL=https://xxxx.ngrok-free.app   # o tu hosting
DRY_RUN=0
```

`PUBLIC_MEDIA_BASE_URL` se usa para Instagram y TikTok. (También puedes definir
`INSTAGRAM_MEDIA_BASE_URL` / `TIKTOK_MEDIA_BASE_URL` por separado.)

### 4. Verifica que las URLs son accesibles

```bash
npm run media:urls    # imprime la URL pública de cada archivo y comprueba el acceso
```

Debe mostrar `✅ accesible` para cada archivo.

### 5. Publica

```bash
npm run publish -- --force
```

El flujo real que ejecuta el agente (verificado con tests contra las APIs simuladas):

- **Instagram**: crea el *container* (`POST /{user}/media`), espera a que Meta
  procese la media (polling de `status_code`), y hace `media_publish`.
- **TikTok**: inicializa la publicación (`/post/publish/video/init/`), sube el
  vídeo si la API lo pide (modo PUSH) o lo deja descargar de tu URL (modo PULL),
  y consulta el estado hasta `PUBLISH_COMPLETE`.

> **En desarrollo/CI** puedes probar el flujo completo sin credenciales: los tests
> en `src/test/publish-flow.test.ts` levantan un mock de la Graph API y de TikTok
> y verifican cada paso de la publicación (con `INSTAGRAM_GRAPH_BASE` y
> `TIKTOK_API_BASE` sobreescribibles por entorno).

## 🧠 El agente experto

El prompt de sistema aplica **técnicas de copywriting** a cada publicación:

- **Gancho en la primera línea** con fórmulas probadas: cifra llamativa, pregunta
  incómoda, afirmación audaz, curiosidad incompleta o beneficio concreto.
- **Estructuras AIDA y PAS** según el objetivo del post (informar, inspirar,
  vender, conversación).
- **Especificidad** (números, datos), palabras de poder con moderación y
  *call to action* variado por plataforma.
- **🧪 Variantes A/B**: cada draft incluye 2-3 ganchos alternativos completos
  (`variants`), listos para publicar. En el panel web se eligen con un clic
  (botón "Usar").

### 🗓️ Plan editorial semanal

```bash
npm run plan        # genera reports/plan-YYYY-Www.md con el plan de la semana
```

El agente (o la plantilla) propone **pilares de contenido**, un **calendario día a
día** con canal, horario óptimo, gancho y objetivo por publicación, y **variantes
A/B** para la publicación principal.

### 🎨 Imagen gratis para tus posts

```bash
npm run gen-image -- "una app de productividad en un escritorio minimalista"
node dist/cli.js gen-image <id-de-contenido>   # usa el título de un ítem
```

Sin clave usa **Pollinations** (gratis, sin registro); con `HF_TOKEN` usa
**Hugging Face** (FLUX.1-schnell). La imagen se guarda en `content/media/` y se
ingesta automáticamente con `npm run ingest`.

> 💾 **Espacio en disco y opciones gratuitas** (LLM, imagen y vídeo, sin pagos
> sorpresa): ver **`docs/llm-disk-space.md`**. En resumen: la nube gratuita
> (OpenRouter/Gemini/Groq) ocupa 0 MB; Ollama local con llama3.1:8b ~7 GB;
> tu máquina tiene ~132 GB libres.

### 🧪 Test en un servidor dedicado

Todo el despliegue para un **servidor Linux** está en **`deploy/`**: Ollama
en espacio de usuario (sin root) con los modelos en **`/mnt/storage/ollama`**,
`.env` de test en seco (`deploy/server.env`) y un smoke test del pipeline
completo. Ver **`deploy/README-servidor.md`** para los comandos, requisitos
de hardware (GPU NVIDIA recomendada) y verificación.

> ⚙️ En hardware potente con GPU, llama3.1:8b genera los posts en segundos.
> Sin GPU funciona igual pero lento (el streaming SSE del cliente LLM ya
> está implementado, así que no hay cortes por tiempo de conexión). Para
> producción sin GPU, usa una API gratuita en la nube (ver
> `docs/llm-disk-space.md`).

## 🖥️ Panel web de revisión y aprobación

```bash
npm run panel        # abre http://localhost:4000 (cambia el puerto con PANEL_PORT=5000)
```

Panel web (sin dependencias, solo `node:http`) para revisar drafts **antes** de
publicar, con el flujo aprobar/descartar en vivo:

- **Vista previa por plataforma**: cada draft se muestra como se vería en
  Mastodon, Bluesky, X, LinkedIn, Instagram, Facebook o TikTok (tarjetas mock con
  avatar, texto, hashtags y botones de engagement).
- **Edición en vivo**: textarea con contador de caracteres frente al límite real
  de cada canal (se marca en rojo al superarlo), etiquetas editables y guardado
  automático (debounce).
- **Estrategia visible**: la justificación del agente (`rationale`) en un panel
  desplegable.
- **Acciones**: ✅ Aprobar todos (programa en horarios óptimos), 🕐 Programar
  (aprueba un draft), 🚀 Publicar ahora, 🔁 Reintentar fallidos y 🗑 Descartar.
- **Pestaña ⚙️ Config**: resumen de la **IA en uso ahora mismo**, **🔌 Conectores
  de IA** (define varias IAs con nombre: local, tu máquina con Qwen, APIs en la
  nube…), **🧠 IA por canal** (cada plataforma elige uno de esos conectores o la
  global), el selector 🐢⚡ potencia/velocidad por defecto
  (`ahorro`/`equilibrado`/`rendimiento`), un **selector de canales** para
  habilitar/deshabilitar cada plataforma (con indicación de si tiene
  credenciales), el **modo de publicación** (🧪 simulación/en vivo con `DRY_RUN`
  y 🤖 autónomo/borradores con `AUTO_PUBLISH`) y la **ruta del `.env`** con
  botones para 👁️ abrirlo y ⬇️ descargarlo (panel local), con botón **🧪 Probar
  y guardar** que comprueba la conexión en vivo. La IA global no se configura
  aquí: se detecta sola (Ollama/LM Studio local, `OLLAMA_BASE_URL` o el `.env`).
  Lo que guardes se persiste en `data/ui-config.json` (ignorado por git) y se
  aplica **en caliente** a la generación y al estado del panel, sin reiniciarlo;
  los conectores y su asignación por canal los lee también el CLI (`generate`,
  `serve`, `llm:check`…) sin abrir el panel.
- **👋 Primer arranque**: la primera vez que abras el panel (o si no hay IA
  configurada), un asistente te da la bienvenida y te lleva a la ⚙️ Config para
  definir conectores; puedes omitirlo y volver luego.
- **Media preview**: imágenes/videos adjuntos visibles en el propio panel.
- **Pestaña ⚡ Generar**: sube fotos/vídeos/audio (arrastrando o con el botón) a
  `content/media/` y añade ideas de texto, y todo se ingiere al instante. Con el
  botón **✨ Generar drafts con IA** (o por ítem) el agente habla con la IA y
  crea los drafts sin salir del panel, con **progreso en vivo** (ítem actual,
  `x/y` y drafts listos vía `GET /api/generation`, actualizado cada ~1s). Cada
  ítem tiene un botón 🗑 para **eliminarlo** (con confirmación): quita el ítem,
  sus drafts y el archivo fuente (.md o media) del disco. También puedes
  **arrastrar archivos .md/.txt** (o texto suelto) como ideas y **pegar URLs de
  YouTube/TikTok** para descargar el vídeo solo a `content/media` (requiere
  yt-dlp: `npm run setup:tools`).

API REST integrada (`GET /api/state`, `PATCH /api/posts/:id/edit`,
`POST /api/posts/:id/{schedule|publish|discard}`, `POST /api/posts/approve-all`,
`POST /api/generate` (con `itemId` opcional para un ítem concreto),
`POST /api/media` (cuerpo crudo + cabecera `X-File-Name`),
`POST /api/ideas`, `POST /api/ideas-file`, `POST /api/import-url`,
`DELETE /api/items/:id`). Solo escucha en `127.0.0.1`. Se integra con el resto de
comandos: lo que subas, generes, programes o publiques desde el panel se
refleja en `status`, `calendar`, `metrics` y `report`.

## 📅 Calendario editorial y métricas

### Calendario editorial

```bash
npm run calendar        # vista de la semana: posts publicados/programados + huecos recomendados
npm run calendar:md     # exporta a content/calendario-editorial.md
npm run schedule:learn  # aprende los horarios óptimos del engagement real (data/schedule-learned.json)
npm run credentials:check  # verifica en vivo las credenciales de Mastodon y Bluesky
```

Agrupa los posts de la semana (publicados/programados) y calcula los **próximos
huecos de publicación** por canal usando los horarios óptimos de cada plataforma.

### 🎯 Horarios que aprenden de tus datos

Cada plataforma parte de franjas recomendadas (p. ej. LinkedIn mar-jue 8-11h).
Con `npm run schedule:learn` el agente analiza el **engagement real** de tus
posts publicados (likes, reposts ×2, comentarios ×3, clics) y ajusta las
franjas por canal — con pocas muestras conserva el prior estático y, con
datos suficientes, da prioridad a las horas que mejor te funcionan:

```bash
npm run metrics          # 1. recopila seguidores y engagement → data/metrics.json
npm run schedule:learn   # 2. aprende y guarda → data/schedule-learned.json
npm run calendar         # 3. el calendario marca los huecos "(aprendido)"
```

El modelo aprendido se usa automáticamente en `publish`/`serve`, en el botón
🕐 Programar del panel y en el calendario. Si no hay datos aún, todo sigue
funcionando con el prior estático.

### Métricas por canal

```bash
npm run metrics
```

Recopila y guarda en `data/metrics.json`:

- **Seguidores**: consulta en vivo para Mastodon (`verify_credentials`) y Bluesky
  (`getProfile`).
- **Engagement por post** (likes, reposts, comentarios): en vivo para Mastodon
  (`/api/v1/statuses/{id}`) y Bluesky (`getPostThread`).
- **Resto de canales** (X, LinkedIn, Instagram, Facebook, TikTok): rellena
  `data/metrics-manual.json` con los datos de tus paneles (formato de ejemplo
  incluido en el archivo). El comando `metrics` los fusiona con los datos en vivo.

### Informe semanal (generado por el agente)

```bash
npm run report
```

El agente analiza los datos de la semana (posts publicados, engagement y
seguidores) y escribe un **informe ejecutivo en `reports/YYYY-Www.md`** con:
resumen ejecutivo, tabla de rendimiento por canal, mejor contenido de la semana,
insights accionables y **calendario sugerido para la próxima semana**.

- Con `LLM_API_KEY` configurada, el informe lo redacta el agente LLM (analista de
  métricas). Sin clave, se usa una plantilla estructurada con los mismos datos.

## Estructura del proyecto

```
content/
  ideas/          # ideas base en .md/.txt (una idea por archivo)
  media/          # fotos y videos (jpg, png, mp4, mov, …)
data/agent.json   # estado persistente (ítems, drafts, posts publicados)
src/
  cli.ts          # comandos: ingest, generate, publish, serve, status, channels,
                  #          media-urls, metrics, calendar, report, panel
  panel/          # servidor web + panel de revisión (node:http, sin dependencias)
  ingest.ts       # escaneo de ideas y media
  agent/          # el agente experto (generación de posts + informe semanal)
  channels/       # adaptadores por red (Mastodon, Bluesky, X, LinkedIn, IG, FB, TikTok)
  metrics.ts      # seguidores y engagement por canal (en vivo + manual)
  scheduler.ts    # horarios óptimos por plataforma
  publisher.ts    # orquestación de publicación y reintentos
  storage.ts      # persistencia JSON
reports/          # informes semanales (YYYY-Www.md)
data/
  agent.json           # estado de la cola
  metrics.json         # métricas recopiladas
  metrics-manual.json  # métricas manuales de canales sin API
```

## Comandos útiles

```bash
npm run status                  # estado completo de la cola
npm run publish -- --force      # publica drafts y reintenta fallidos ya
npm test                        # tests (51): scheduler, generador (con A/B), flujos IG/TikTok, métricas, informes, plan, API del panel (generar, subir media/ideas, importar URLs, borrar)
npm run serve:media             # sirve content/media en :8787 (para IG/TikTok)
npm run media:urls              # muestra y verifica las URLs públicas de la media
npm run panel                   # panel web para revisar y aprobar drafts
npm run calendar                # calendario editorial de la semana
npm run metrics                 # seguidores y engagement por canal
npm run report                  # informe semanal generado por el agente
npm run plan                    # plan editorial semanal (pilares + calendario)
npm run gen-image -- "prompt"   # imagen gratis (Pollinations/HF)
```

## 🌐 Demo en GitHub Pages

El sitio público en
[**https://re1m0n.github.io/social-agent/**](https://re1m0n.github.io/social-agent/)
(se actualiza solo en cada push a `main`) consta de dos partes:

- **Landing page** (raíz): presenta el proyecto y enlaza a la demo y al repo.
- **Demo del panel** en [`/panel/`](https://re1m0n.github.io/social-agent/panel/):
  el panel real como demo estática (sin backend). El modo se elige con el
  selector **🖥 Servidor / 🧪 Demo** de la cabecera:

- **Auto (por defecto)**: intenta conectar con la API; si no hay backend
  (GitHub Pages, `file://`), cae automáticamente al modo demo.
- **🧪 Demo**: datos de ejemplo y acciones simuladas en el navegador, para ver
  la interfaz sin tocar tu cola real.
- **🖥 Servidor**: fuerza la conexión al panel real (`npm run panel`). Si no
  hay servidor, muestra un banner de error en vez de cambiar de modo a solas.

## Notas de producción

- **Empieza en simulación**: `DRY_RUN=1` (default) marca los posts como publicados sin tocar APIs.
- **Primera vez en vivo**: publica un post manual en cada canal y compruébalo antes de dar rienda suelta.
- Los posts fallidos se marcan como `failed` con el error; `publish --force` los reintenta.
- El estado vive en `data/agent.json`; borrarlo reinicia la cola.

## Licencia

MIT. Ver [LICENSE](LICENSE).
