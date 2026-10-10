// Gemini, called straight from the browser with the visitor's own key.

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// JSON Schema -> the OpenAPI-style subset Gemini's responseSchema accepts.
function geminiSchema(schema) {
  const out = { type: schema.type.toUpperCase() };
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, geminiSchema(v)]));
    out.required = schema.required || [];
  }
  if (schema.items) out.items = geminiSchema(schema.items);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiError(status, detail) {
  if (status === 400 && /api key/i.test(detail)) return "That Gemini API key isn't valid. Check it and try again.";
  if (status === 403) return "This Gemini API key isn't allowed to use the Gemini API. Make a new key at aistudio.google.com/apikey.";
  if (status === 429) return "Your Gemini key hit its rate limit. Wait a minute and try again.";
  return `Gemini error ${status}: ${detail}`;
}

async function askGemini(key, system, prompt, schema) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(schema) },
  });

  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
    } catch {
      throw new Error("Couldn't reach Gemini. Check your internet connection.");
    }
    if (res.ok) { data = await res.json(); break; }
    let detail = await res.text();
    try { detail = JSON.parse(detail).error.message; } catch {}
    if ([429, 500, 503].includes(res.status) && attempt < 2) {  // busy - wait and retry
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(geminiError(res.status, detail));
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error("Gemini blocked this request.");
  const candidate = (data.candidates || [{}])[0];
  if (candidate.finishReason === "MAX_TOKENS") throw new Error("Gemini's reply was cut off - try again.");
  const text = ((candidate.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Gemini returned no answer (${candidate.finishReason || "unknown reason"}).`);
  return JSON.parse(text);
}

// Cheap key check at login: looks up the model, uses no tokens.
async function checkKey(key) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}`, { headers: { "x-goog-api-key": key } });
  } catch {
    throw new Error("Couldn't reach Gemini. Check your internet connection.");
  }
  if (res.ok) return;
  let detail = await res.text();
  try { detail = JSON.parse(detail).error.message; } catch {}
  throw new Error(geminiError(res.status === 404 ? 400 : res.status, detail));
}

// ---------------------------------------------------------------- prompts

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          kind: { type: "string", enum: ["explain", "why", "what-if"] },
          key_points: { type: "array", items: { type: "string" } },
        },
        required: ["question", "kind", "key_points"],
      },
    },
  },
  required: ["title", "questions"],
};

const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    headline: { type: "string" },
    got_right: { type: "array", items: { type: "string" } },
    missed: { type: "array", items: { type: "string" } },
    go_further: { type: "array", items: { type: "string" } },
    model_answer: { type: "string" },
  },
  required: ["score", "headline", "got_right", "missed", "go_further", "model_answer"],
};

function questionSystem(project) {
  return `You are a friendly senior software engineer quizzing the student who wrote this code - ` +
    `a ${project.language} project called "${project.name}". ` +
    "The goal is a daily 5-10 minute warm-up that makes them truly understand their own code.";
}

const QUESTION_KINDS = {
  code: `- explain: what a specific part does, step by step
- why: why it is written this way (a design choice, a rule of the language, framework or library)
- what-if: what breaks or changes if something is removed, reordered, or receives unexpected input (null/empty values, errors, slow network, concurrency)`,
  markup: `- explain: what this part of the markup/styles does and how it will look or behave on screen
- why: why specific attributes, selectors or values are used (sizing, layout, constraints, references, theming)
- what-if: what changes on screen if an attribute or rule is removed or changed (small screens, long text, missing ids, dark mode)`,
};

function describeChunk(chunk) {
  const where = isMarkup(chunk) ? chunk.owner : `inside ${chunk.owner}`;
  return `from ${chunk.file} (lines ${chunk.start}-${chunk.end}, ${where}):

\`\`\`${chunk.lang}
${chunk.code}
\`\`\``;
}

function makeQuestions(key, project, chunk) {
  const prompt = `Here is today's chunk, ${describeChunk(chunk)}

Write 3 or 4 questions about THIS chunk, answerable in a few sentences, typed or spoken. Mix the kinds:
${QUESTION_KINDS[isMarkup(chunk) ? "markup" : "code"]}
Refer to exact names from the code. Order from easier to harder.
For each question give 2-5 key_points a strong answer would cover (used later for grading, not shown up front).
"title" is a short name for what the chunk does (max 6 words).`;
  return askGemini(key, questionSystem(project), prompt, QUESTION_SCHEMA);
}

function gradeAnswer(key, project, chunk, q, answer) {
  const prompt = `Code ${describeChunk(chunk)}

Question: ${q.question}
Key points a strong answer covers: ${JSON.stringify(q.key_points)}

The student's answer (it may be speech-to-text, so ignore transcription glitches, filler words and grammar):
"""${answer}"""

Grade it like an encouraging mentor:
- score: 0-100 for how completely and correctly it answers the question.
- headline: one short sentence verdict.
- got_right: specific things they said that are correct (empty if nothing).
- missed: what was wrong or missing, explained briefly so they learn it.
- go_further: 1-3 ways to deepen the answer or the code beyond the question.
- model_answer: a concise ideal answer (3-6 sentences).
Be specific to their words and the code. Reply in the same language the student answered in.`;
  return askGemini(key, questionSystem(project), prompt, FEEDBACK_SCHEMA);
}
