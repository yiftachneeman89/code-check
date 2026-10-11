// Everything server.py did, kept in this browser: rounds, streak, history, mastery.
// The uploaded code lives in IndexedDB (too big for localStorage); the rest in localStorage.
// Keys are prefixed because every GitHub Pages site of one account shares an origin.

const PREFIX = "cc.";

// localStorage can be unavailable (private windows) - never let that break the page
const store = {
  get(k) { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch { throw new Error("This browser won't let the site save anything. Turn off private browsing and try again."); } },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch {} },
  json(k, fallback) { try { return JSON.parse(this.get(k)) ?? fallback; } catch { return fallback; } },
  setJson(k, v) { this.set(k, JSON.stringify(v)); },
  clear() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
    } catch {}
  },
};

// ---------------------------------------------------------------- code storage (IndexedDB)

const DB_NAME = "code-check";

function openDb() {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(new Error("This browser won't let the site save your code. Turn off private browsing and try again."));
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  await new Promise((ok, fail) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = ok;
    tx.onerror = () => fail(tx.error);
  });
  db.close();
}

async function dbGet(key) {
  const db = await openDb();
  const value = await new Promise((ok, fail) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  db.close();
  return value;
}

function dbWipe() {
  return new Promise((ok) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => ok();
  });
}

// Browsers may clear site data when the disk gets full unless the site asks to keep it.
// Asking once is enough; Edge and Chrome grant it silently for sites you use.
function keepForever() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
}

// ---------------------------------------------------------------- session

const Session = {
  key: null,
  project: null,   // { name, language, files, lines }
  files: [],       // [{ path, lang, code }]
  chunks: [],

  async load() {
    this.key = store.get("key");
    this.project = store.json("project", null);
    if (!this.key || !this.project) return false;
    const files = await dbGet("files").catch(() => null);
    if (!files || !files.length) return false;
    this.setFiles(files);
    return true;
  },

  setFiles(files) {
    this.files = files;
    this.chunks = allChunks(files);
  },

  async save(key, project, files) {
    keepForever();
    await dbPut("files", files);
    store.set("key", key);
    store.setJson("project", project);
    this.key = key;
    this.project = project;
    this.setFiles(files);
  },

  async logout() {
    store.clear();
    await dbWipe();
    this.key = this.project = null;
    this.files = this.chunks = [];
  },
};

// ---------------------------------------------------------------- rounds

// A day can have any number of rounds (one chunk + its questions each), ids "2026-10-10",
// "2026-10-10_02", ... The streak only needs DAILY_GOAL answers across all of a day's rounds.
const DAILY_GOAL = 3;
const MASTERED_AT = 80;
const CODE_SHARE = 0.7;  // how often a chunk is real code rather than markup/styles

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = () => isoDate(new Date());

const allRounds = () => store.json("rounds", {});
const saveRound = (state) => store.setJson("rounds", { ...allRounds(), [state.round_id]: state });

function roundsFor(d) {
  return Object.keys(allRounds()).filter((r) => r === d || r.startsWith(`${d}_`)).sort();
}

function answeredOn(d) {
  const rounds = allRounds();
  return roundsFor(d).reduce((n, r) => n + Object.keys(rounds[r].answers || {}).length, 0);
}

function chunkResults() {
  const results = {};
  const rounds = allRounds();
  for (const rid of Object.keys(rounds).sort()) {  // oldest first, so later days win
    const s = rounds[rid];
    const scores = Object.values(s.answers || {}).filter((a) => a.feedback).map((a) => a.feedback.score);
    if (!scores.length) continue;
    results[s.chunk.id] = { score: scores.reduce((a, b) => a + b, 0) / scores.length, complete: scores.length >= s.questions.length };
  }
  return results;
}

function chunkStatus(result) {
  if (!result) return "unseen";
  return result.complete && result.score >= MASTERED_AT ? "mastered" : "learning";
}

function pickChunk(exclude = []) {
  const chunks = Session.chunks;
  if (!chunks.length) throw new Error("No quiz-sized code found in your upload. Try uploading your whole project folder.");
  let used = store.json("used", []);
  let fresh = chunks.filter((c) => !used.includes(c.id) && !exclude.includes(c.id));
  if (!fresh.length) {  // seen everything - revisit what isn't mastered yet, then start over
    used = [];
    const results = chunkResults();
    const open = chunks.filter((c) => !exclude.includes(c.id));
    fresh = open.filter((c) => chunkStatus(results[c.id]) !== "mastered");
    if (!fresh.length) fresh = open.length ? open : chunks;
  }
  const code = fresh.filter((c) => !isMarkup(c));
  const markup = fresh.filter(isMarkup);
  if (code.length && markup.length) fresh = Math.random() < CODE_SHARE ? code : markup;
  const chunk = fresh[Math.floor(Math.random() * fresh.length)];
  used.push(chunk.id);
  store.setJson("used", used);
  return chunk;
}

async function newRound(rid, exclude = []) {
  const chunk = pickChunk(exclude);
  const qs = await makeQuestions(Session.key, Session.project, chunk);
  const state = { date: rid.slice(0, 10), round_id: rid, chunk, title: qs.title, questions: qs.questions, answers: {} };
  saveRound(state);
  return state;
}

async function getRound(rid) {
  let state = allRounds()[rid];
  if (!state) state = await newRound(rid);
  else if (!Object.keys(state.answers).length && !Session.chunks.some((c) => c.id === state.chunk.id)) {
    // the chunk is gone (the code was re-uploaded) - pick another
    state = await newRound(rid, [state.chunk.id]);
  }
  return dropUnwantedQuestions(state);
}

const UNWANTED_KINDS = new Set(["improve", "concept"]);  // question kinds that were removed

// Remove dropped question kinds from a saved round, keeping answers on the right questions.
function dropUnwantedQuestions(state) {
  const keep = state.questions.map((q, i) => i).filter((i) => !UNWANTED_KINDS.has(state.questions[i].kind));
  if (keep.length === state.questions.length) return state;
  const answers = {};
  keep.forEach((old, i) => { if (state.answers[String(old)]) answers[String(i)] = state.answers[String(old)]; });
  state = { ...state, questions: keep.map((i) => state.questions[i]), answers };
  saveRound(state);
  return state;
}

function dailyStatus() {
  const done = answeredOn(today());
  return { streak: streak(), today_answered: done, goal: DAILY_GOAL, goal_met: done >= DAILY_GOAL };
}

function streak() {
  let n = 0;
  const d = new Date();
  if (answeredOn(isoDate(d)) < DAILY_GOAL) d.setDate(d.getDate() - 1);  // today not done yet - streak still alive from yesterday
  while (answeredOn(isoDate(d)) >= DAILY_GOAL) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function publicView(state) {
  const rounds = roundsFor(state.date);
  return {
    ...state,
    questions: state.questions.map((q) => ({ question: q.question, kind: q.kind })),
    round: Math.max(rounds.indexOf(state.round_id) + 1, 1),
    ...dailyStatus(),
  };
}

// ---------------------------------------------------------------- the old /api endpoints

const Quiz = {
  async today() {
    const rounds = roundsFor(today());
    return publicView(await getRound(rounds.length ? rounds[rounds.length - 1] : today()));
  },

  async reroll(rid) {
    const old = allRounds()[rid];
    return publicView(await newRound(rid, old ? [old.chunk.id] : []));
  },

  async next() {
    const d = today();
    const rounds = roundsFor(d);
    const done = rounds.map((r) => allRounds()[r].chunk.id);
    const rid = rounds.length ? `${d}_${String(rounds.length + 1).padStart(2, "0")}` : d;
    return publicView(await newRound(rid, done));
  },

  async grade(index, answer, rid) {
    if (!rid.startsWith(today())) throw new Error("That was a past day's chunk. Reload the page for today's.");
    const state = allRounds()[rid];
    const q = state && state.questions[index];
    if (!q) throw new Error("That question doesn't exist any more. Reload the page.");
    const before = dailyStatus().goal_met;
    const feedback = await gradeAnswer(Session.key, Session.project, state.chunk, q, answer);
    feedback.key_points = q.key_points;
    const fresh = allRounds()[rid];  // re-read in case another tab saved meanwhile
    fresh.answers[String(index)] = { answer, feedback };
    saveRound(fresh);
    const status = dailyStatus();
    return { feedback, ...status, goal_just_met: status.goal_met && !before };
  },

  history() {
    const days = {};
    const rounds = allRounds();
    for (const rid of Object.keys(rounds).sort()) {
      const s = rounds[rid];
      const day = days[s.date] || (days[s.date] = { date: s.date, titles: [], scores: [], answered: 0 });
      day.titles.push(s.title);
      const answers = Object.values(s.answers || {});
      day.answered += answers.length;
      day.scores.push(...answers.filter((a) => a.feedback).map((a) => a.feedback.score));
    }
    return Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map((d) => ({
      date: d.date,
      title: d.titles[0],
      rounds: d.titles.length,
      answered: d.answered,
      goal: DAILY_GOAL,
      goal_met: d.answered >= DAILY_GOAL,
      avg: d.scores.length ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length) : null,
    }));
  },

  mastery() {
    const results = chunkResults();
    const files = {};
    const totals = { lines: 0, mastered: 0, learning: 0, known: 0 };
    for (const c of Session.chunks) {
      const n = c.end - c.start + 1;
      const r = results[c.id];
      const status = chunkStatus(r);
      const f = files[c.file] || (files[c.file] = { file: c.file, name: c.file.split("/").pop(), lines: 0, mastered: 0, learning: 0, known: 0, chunks: 0 });
      for (const bucket of [f, totals]) {
        bucket.lines += n;
        if (status !== "unseen") { bucket[status] += n; bucket.known += n * r.score / 100; }
      }
      f.chunks++;
    }
    const pct = (part, whole) => (whole ? Math.round(10000 * part / whole) / 100 : 0);
    const rows = Object.values(files).map((f) => ({
      file: f.file, name: f.name, chunks: f.chunks,
      mastered_pct: pct(f.mastered, f.lines),
      learning_pct: pct(f.learning, f.lines),
      known_pct: pct(f.known, f.lines),
    }));
    rows.sort((a, b) => b.known_pct - a.known_pct || a.name.localeCompare(b.name));
    return {
      mastered_pct: pct(totals.mastered, totals.lines),
      learning_pct: pct(totals.learning, totals.lines),
      known_pct: pct(totals.known, totals.lines),
      files: rows,
      mastered_at: MASTERED_AT,
    };
  },

  file(path) {
    const f = Session.files.find((x) => x.path === path);
    if (!f) throw new Error("That file isn't in your uploaded code any more.");
    return { file: f.path, lang: f.lang, code: f.code };
  },
};
