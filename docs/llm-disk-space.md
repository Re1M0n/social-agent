# 💾 Espacio en disco y opciones de IA (LLM, imagen, vídeo)

Análisis para decidir cómo alimentar al agente con IA real: **cloud gratuito vs.
local (Ollama)**, cuánto disco ocupa cada opción, y APIs gratuitas de imagen y
vídeo sin sorpresas de pago.

> Tu máquina tiene **~132 GB libres** (C:). Suficiente para cualquier opción
> local de tamaño razonable; la pregunta no es el disco sino RAM/GPU y límites
> de las APIs gratuitas.

---

## 1. LLM: la opción más barata y fiable es la nube (0 GB en disco)

Usar una API en la nube **no ocupa disco** (solo el código del agente, ~50 MB
con `node_modules`). Varias opciones gratuitas de verdad, sin tarjeta:

| Proveedor | Modelos gratuitos | Límites típicos | Sin tarjeta | Notas |
|---|---|---|---|---|
| **OpenRouter** `:free` | 20+ modelos (Llama 3.3, Qwen, DeepSeek…) | ~50-1000 req/día según modelo | ✅ | Compatible con OpenAI — **la más fácil**: solo cambiar `LLM_BASE_URL` |
| **Google Gemini (AI Studio)** | Gemini 2.5 Pro/Flash | ~50-250 req/día | ✅ | Muy buena calidad, clave gratis en aistudio.google.com |
| **Groq** | Llama 3.3 70B, etc. | ~14.400 req/día (rate limits por minuto) | ✅ | Muy rápido |
| **Cerebras** | Llama 3.3 70B | generoso | ✅ | Rápido, compatible OpenAI |
| **Hugging Face Inference** | varios | créditos mensuales gratuitos | ✅ | Mismo token sirve para imagen |
| **NVIDIA NIM** | Llama, Qwen… | limitado | ✅ | Developer program |

**Configuración con este agente** (`.env`), ejemplo con OpenRouter gratis:

```bash
LLM_API_KEY=sk-or-v1-…            # de openrouter.ai (sin tarjeta)
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=meta-llama/llama-3.3-70b-instruct:free
```

**Disco: 0 MB** para el LLM. El agente (código) ocupa ~50 MB. **Esta es la
opción recomendada**: máxima calidad, cero mantenimiento, cero disco.

### ⚠️ Evitar pagos sorpresa (reglas de oro)

1. **Nunca des tarjeta** a un servicio de "prueba gratis" — OpenRouter/Gemini/Groq/Cerebras dan claves sin tarjeta.
2. En OpenRouter, usa modelos con sufijo `:free` — el router **rechaza** llamadas a modelos de pago si no hay crédito; así no hay factura accidental.
3. Los límites gratuitos son **por día**; el agente publica pocos posts al día, así que no los agotarás.
4. Desconfía de "API gratis ilimitada": si suena demasiado bien, suelen ser proxies inestables o con tarjeta al final.

---

## 2. LLM local con Ollama: cuánto disco de verdad

Ollama descarga los modelos en `C:\Users\<usuario>\.ollama\models`. Tamaños
(versiones cuantizadas Q4, las que usa por defecto):

| Modelo | Params | Tamaño en disco | RAM/VRAM mínima | Calidad |
|---|---|---|---|---|
| `llama3.2:1b` | 1.3B | **~1.3 GB** | 4 GB | Muy básica (no recomendada) |
| `gemma3:4b` / `llama3.2:3b` | 3-4B | **~2.0-2.5 GB** | 8 GB | Aceptable |
| `llama3.1:8b` / `qwen2.5:7b` | 7-8B | **~4.7-5.0 GB** | 8-16 GB | Buena — **recomendado** |
| `gemma3:12b` / `qwen2.5:14b` | 12-14B | **~8-9 GB** | 16 GB | Muy buena |
| `qwen2.5:32b` | 32B | **~19 GB** | 32 GB | Excelente (pesada) |

Más el propio Ollama: instalador + runtime ≈ **1-2 GB**.

**Totales locales:**
- Plan "ligero" (gemma3:4b): ~**4 GB** de disco, 8 GB RAM → fluido en CPU.
- Plan "recomendado" (llama3.1:8b): ~**7 GB** de disco, 8-16 GB RAM → correcto en CPU, mejor con GPU.
- Plan "potente" (qwen2.5:14b): ~**11 GB** de disco, 16 GB RAM.

Con tus 132 GB libres, **cualquiera cabe**. El cuello de botella es RAM/CPU:
sin GPU, un 8B genera 1 post en ~10-30 s. Para este agente (unos pocos posts al
día) es perfectamente viable y **100 % privado y gratis**.

Configuración en `.env` (opcional — el agente detecta Ollama solo):

```bash
# Opción A: automática. Con Ollama arrancado, el agente lo detecta en
# localhost:11434 y elige el mejor modelo (Qwen, Llama, Gemma…) sin tocar nada:
LLM_LOCAL=auto

# Opción B: manual (la de siempre).
LLM_API_KEY=ollama                  # cualquier valor: Ollama no la valida
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1:8b

# Opción C: Ollama en OTRA máquina (p. ej. un servidor con Qwen):
# OLLAMA_BASE_URL=http://192.168.1.50:11434
# OLLAMA_MODEL=qwen2.5:14b          # opcional: si no, elige el mejor
```

Instalar un modelo: `ollama pull llama3.1:8b` (o `gemma3:4b` para menos RAM,
`qwen2.5:14b` para el plan potente).

---

## 3. Imagen: APIs gratuitas de verdad (y el comando `gen-image`)

| Servicio | Coste | Clave | Notas |
|---|---|---|---|
| **Pollinations** (`image.pollinations.ai`) | **Gratis ilimitado** | **No necesita clave** | Solo una URL: `https://image.pollinations.ai/prompt/{prompt}` |
| **Hugging Face Inference** | Créditos mensuales gratis | Sí (gratis, sin tarjeta) | FLUX.1-schnell, SDXL, Qwen-Image |
| Local (Stable Diffusion / FLUX con ComfyUI) | 0 | — | **8-20 GB** de disco + GPU recomendada |

> ⚠️ En 2026 Pollinations lanzó `gen.pollinations.ai` (con clave); el endpoint
> clásico `image.pollinations.ai` sigue siendo gratis y sin clave.

El agente incluye un comando para generar la imagen de un ítem de contenido y
dejarla lista para publicar (se ingesta automáticamente):

```bash
npm run gen-image -- "una app de productividad en un escritorio minimalista"
# o por ítem:  node dist/cli.js gen-image <id-de-contenido> [prompt]
```

- Sin clave → usa **Pollinations** (gratis).
- Con `HF_TOKEN` → usa **Hugging Face** (FLUX.1-schnell).

**Disco**: cada imagen ~1-3 MB.

---

## 4. Vídeo: la realidad (2026)

No hay una API de vídeo gratuita **fiable** hoy:

- **Hugging Face** tiene modelos text-to-video (CogVideoX) pero el tier gratuito
  es lento, con colas y generación en minutos (no apto para pipeline automático).
- **Pollinations** anuncia vídeo pero el endpoint requiere clave/créditos.
- **Local (CogVideoX 2B)**: ~6-10 GB de modelo, pero exige **GPU con 12-16 GB
  de VRAM** y genera clips de ~4-6 s. Sin GPU no es práctico.

**Recomendación honesta**: no integres vídeo IA gratis en el pipeline por ahora.
Alternativa gratuita y 100 % fiable: **slideshow con ffmpeg** — el agente genera
los posts y las imágenes, y un script local monta el vídeo (imágenes + texto +
música). Un vídeo de 15 s ≈ 2-5 MB. Si algún día necesitas vídeo IA de calidad,
paga por uso puntual (fal.ai, Replicate) sabiendo que es opcional y no automático.

---

## 5. Resumen

| Opción | Disco | Coste | Calidad | Veredicto |
|---|---|---|---|---|
| **Cloud gratis (OpenRouter/Gemini/Groq)** | 0 MB | 0 € (sin tarjeta) | Alta | ⭐ **Recomendada** |
| **Ollama local (llama3.1:8b)** | ~7 GB | 0 € | Buena | ⭐ Privada y offline |
| **Imagen: Pollinations/HF** | ~0 (por imagen 1-3 MB) | 0 € | Buena | ⭐ Úsala con `gen-image` |
| **Vídeo IA gratis** | — | 0 € | Pobre/no fiable | ⚠️ Evitar; usar ffmpeg |
