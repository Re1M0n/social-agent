# 🗓️ Prompt del agente: plan de contenido de 30 días (adaptable)

> **Para qué sirve**: configura tu agente LLM (Ollama/Qwen, Claude, ChatGPT…) con el
> método de 7 pasos para crear un plan de contenido de **[DURACIÓN DEL PLAN]** días
> desde cero: contexto → investigación → mapa → ganchos → redacción → estilo → calendario.
>
> **Cómo usarlo**: abre un chat nuevo, pega el **Paso 1** y responde lo que te pida.
> Luego pega cada paso en orden, en su propio mensaje. El agente no debe inventar
> datos: si falta algo, que lo pregunte.

---

## ⚙️ Valores a configurar (rellena una vez y reutiliza)

| Placeholder | Qué poner (ejemplo) |
|---|---|
| `[PLATAFORMA]` | La red social del plan: Facebook, Instagram, LinkedIn, X… |
| `[DURACIÓN DEL PLAN]` | 30 días (o 15, 60, 90…) |
| `[NÚMERO DE PUBLICACIONES]` | Total del plan: 30 (una por día) |
| `[CANTIDAD POR CATEGORÍA]` | 5 (6 categorías × 5 = 30) |
| `[TAMAÑO DE LOTE]` | 5 (cuántas publicaciones redacta por tanda) |
| `[DESCRIPCIÓN DEL NEGOCIO]` | Qué hace tu negocio en una frase |
| `[OFERTA]` | Producto/servicio que vendes |
| `[PÚBLICO OBJETIVO]` | A quién ayudas |
| `[PROBLEMA]` | El problema principal que resuelves |
| `[RESULTADO]` | El resultado que entregas |
| `[CTA]` | Tu llamado a la acción |
| `[TUS TEXTOS DE REFERENCIA]` | 3-5 publicaciones escritas por ti (para el tono) |
| `[MATERIAL DE INVESTIGACIÓN]` | Comentarios, preguntas, reseñas o conversaciones reales de tu mercado |

---

## 1️⃣ Configura el contexto

Pega en un chat nuevo:

> Actúa como mi estratega y redactor de contenido para **[PLATAFORMA]**.
> Este es mi negocio: **[DESCRIPCIÓN DEL NEGOCIO]**.
> Mi oferta es: **[OFERTA]**.
> Ayudo a: **[PÚBLICO OBJETIVO]**.
> El problema que resuelvo es: **[PROBLEMA]**.
> El resultado que entrego es: **[RESULTADO]**.
> Mi llamado a la acción es: **[CTA]**.
> Antes de crear contenido, resume lo que entendiste y señala cualquier información importante que falte. No inventes datos.

---

## 2️⃣ Investiga qué le importa al público

Pega **[MATERIAL DE INVESTIGACIÓN]** (comentarios, preguntas, reseñas o conversaciones reales de tu mercado) y utiliza:

> Analiza estas conversaciones e identifica:
> * Problemas repetidos.
> * Deseos.
> * Objeciones.
> * Errores.
> * Preguntas.
> * Soluciones que ya probaron.
> * Expresiones que utilizan.
> Organiza los hallazgos por frecuencia y urgencia. Incluye citas que respalden cada conclusión y no agregues problemas que no aparezcan en el material.

---

## 3️⃣ Crea el mapa de publicaciones

Ahora escribe:

> Utilizando el contexto del negocio y la investigación anterior, crea un mapa de **[NÚMERO DE PUBLICACIONES]** publicaciones:
> * **[CANTIDAD POR CATEGORÍA]** de alcance.
> * **[CANTIDAD POR CATEGORÍA]** sobre problemas.
> * **[CANTIDAD POR CATEGORÍA]** educativas.
> * **[CANTIDAD POR CATEGORÍA]** de autoridad.
> * **[CANTIDAD POR CATEGORÍA]** para responder objeciones.
> * **[CANTIDAD POR CATEGORÍA]** de conversión.
> Para cada publicación incluye objetivo, tema, ángulo y resultado que debe producir en el lector. Evita repetir la misma idea cambiando algunas palabras.

*(Para otro reparto, añade o quita categorías y ajusta las cantidades.)*

---

## 4️⃣ Escribe los ganchos

Continúa con:

> Escribe un gancho para cada una de las **[NÚMERO DE PUBLICACIONES]** publicaciones.
> Varía entre errores, deseos, preguntas, advertencias, situaciones, comparaciones, oportunidades, opiniones y resultados.
> Cada gancho debe poder entenderse sin contexto, abrir curiosidad y conectar con el tema correspondiente.
> No inventes cifras, historias, resultados ni testimonios.

---

## 5️⃣ Redacta las publicaciones

No le pidas todas las publicaciones de una sola vez. Trabaja en grupos de **[TAMAÑO DE LOTE]** y utiliza:

> Redacta las publicaciones **[NÚMEROS]** utilizando los ganchos y ángulos aprobados.
> Cada publicación debe desarrollar una sola idea, utilizar párrafos cortos, incluir ejemplos concretos y terminar según su objetivo.
> No conviertas todas las publicaciones en promociones. Conserva la función asignada a cada una y utiliza el CTA solamente cuando corresponda.

*(Repite este paso hasta cubrir el plan, por ejemplo: 1-5, 6-10, 11-15…)*

---

## 6️⃣ Haz que suenen como tú

Pega **[TUS TEXTOS DE REFERENCIA]** (entre tres y cinco textos escritos por ti) y utiliza:

> Analiza estos textos e identifica mi tono, ritmo, vocabulario, longitud de párrafos, forma de explicar y expresiones habituales.
> Después compara las publicaciones creadas con mi estilo. Elimina frases genéricas, palabras que yo no utilizaría, estructuras demasiado perfectas y repeticiones.
> Reescribe únicamente lo necesario. No inventes opiniones, experiencias ni expresiones personales.

---

## 7️⃣ Organiza y revisa el plan

Para terminar, pega:

> Organiza las publicaciones aprobadas en un calendario de **[DURACIÓN DEL PLAN]** días.
> Incluye día, tipo de contenido, gancho, objetivo y texto correspondiente.
> Distribuye los temas para evitar publicar consecutivamente el mismo problema, estructura o intención.
> Antes de entregar el calendario, verifica que:
> * No existan ideas repetidas.
> * Cada publicación tenga una función clara.
> * El contenido coincida con la oferta y el público.
> * No haya información inventada.
> * Los llamados a la acción aparezcan únicamente donde correspondan.

---

## 💡 Usarlo con el agente de este proyecto

- **Como idea**: guarda este archivo en `content/ideas/` (p. ej. `content/ideas/plan-30-dias.md`) con los placeholders ya rellenos y `npm run generate` lo usará como base para generar drafts en **[PLATAFORMA]** (o todas las plataformas con credenciales).
- **Referencia**: déjalo en `docs/` y úsalo como guía de prompts para tu agente Ollama/Qwen local.
