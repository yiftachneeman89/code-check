const app = document.getElementById("app");

const KIND_LABELS = { explain: "Explain it", why: "Why this way", "what-if": "What if…", improve: "Improve it", concept: "Concept" };
const ICONS = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  swap: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 10a8 8 0 0 0-14.3-3.3L4 10m16 4-1.7 3.3A8 8 0 0 1 4 14"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6m0-6 6 6"/>',
  up: '<path d="M7 17 17 7m0 0H8m9 0v9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  trophy: '<path d="M8 21h8m-4-4v4m-5-17h10v5a5 5 0 0 1-10 0V4Zm10 2h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  files: '<path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7l-4-4Zm0 0v4h4M3 8v12a2 2 0 0 0 2 2h9"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let speechLang = store.get("speechLang") || "en-US";
let activeRecognizer = null;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "html") node.innerHTML = v;
    else node[k] = v;
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function scoreColor(score) {
  return score >= 80 ? "var(--success)" : score >= 50 ? "var(--now)" : "var(--error)";
}

function verdict(score) {
  return score >= 90 ? "Nailed it" : score >= 75 ? "Strong answer" : score >= 50 ? "Getting there" : "Keep going";
}

function toast(text, ms = 1800) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// hljs only knows some languages - unknown ones are shown plain
function highlight(code, lang) {
  if (!window.hljs) return;
  code.className = `language-${hljs.getLanguage(lang) ? lang : "plaintext"}`;
  hljs.highlightElement(code);
}

// ---------------------------------------------------------------- login

function setLoggedIn(on) {
  document.querySelector(".top-actions").hidden = !on;
  document.getElementById("projectName").textContent = on ? Session.project.name : "Quiz yourself on your own code";
}

// ---------------------------------------------------------------- streak + daily goal

let currentDay = null;
let status = { streak: 0, today_answered: 0, goal: 3, goal_met: false };

function setStatus(next) {
  status = { ...status, ...next };
  const { streak, today_answered: done, goal, goal_met: met } = status;
  const pill = document.getElementById("streak");
  document.getElementById("streakNum").textContent = streak;
  pill.classList.toggle("lit", met);
  pill.title = met
    ? `${streak}-day streak · today's goal is done`
    : `Answer ${goal - done} more question${goal - done === 1 ? "" : "s"} today to keep your streak`;

  const box = document.getElementById("dailyGoal");
  if (!box) return;
  box.classList.toggle("met", met);
  box.innerHTML = "";
  const pips = el("div", { className: "pips" },
    ...Array.from({ length: goal }, (_, i) => el("span", { className: i < done ? "pip on" : "pip" })));
  const text = met
    ? (done > goal ? `Goal done · ${done} answered today` : "Daily goal done · streak safe")
    : `${done}/${goal} today · ${goal - done} more to keep your streak`;
  box.append(
    el("span", { className: "dg-flame", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5 5 6 5 11a5 5 0 0 1-10 0c0-2.2 1-3.8 2.2-5 .3 1.6 1 2.6 2 3C11 8 11.5 5 12 2Z"/></svg>' }),
    el("strong", { textContent: "Daily goal" }),
    pips,
    el("span", { className: "dg-text", textContent: text }),
  );
}

async function nextChunk() {
  showLoading("Picking your next chunk…");
  try {
    renderDay(await Quiz.next());
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { showError(e.message); }
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up early" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// ---------------------------------------------------------------- render day

function renderDay(day) {
  app.innerHTML = "";
  currentDay = day;

  let dateText = new Date(day.date + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (day.round > 1) dateText += ` · chunk ${day.round}`;
  if (day.chunk.fresh) dateText += " · code you just wrote";
  const segments = el("div", { className: "segments" }, ...day.questions.map(() => el("span", { className: "seg" })));
  app.append(el("section", { className: "hero" },
    el("div", { className: "hero-top" },
      el("div", {},
        el("p", { className: "eyebrow", textContent: dateText }),
        el("h2", { textContent: greeting() }),
        el("p", { className: "hero-today", html: `Today's code: <strong></strong>` }),
      ),
      el("a", { className: "hero-stat", id: "heroMastery", href: "#mastery", title: "See your codebase mastery" }),
    ),
    el("div", { className: "daily-goal", id: "dailyGoal" }),
    el("div", { className: "progress" },
      segments,
      el("div", { className: "progress-label" }, el("span", { id: "progressText" }), el("span", { id: "progressAvg" })),
    ),
  ));
  app.querySelector(".hero-today strong").textContent = day.title || day.chunk.owner;
  setStatus(day);

  app.append(renderChunk(day));
  app.append(el("p", { className: "eyebrow section-label", textContent: "Your questions" }));
  day.questions.forEach((q, i) => app.append(renderQuestion(q, i, day.answers[String(i)])));
  app.append(el("div", { id: "summary" }));
  app.append(el("p", { className: "eyebrow section-label", textContent: "Your codebase" }));
  app.append(el("section", { className: "card mastery", id: "mastery" }));
  updateProgress();
  loadMastery();
}

// ---------------------------------------------------------------- mastery

let showAllFiles = false;

function loadMastery() {
  try { renderMastery(Quiz.mastery()); }
  catch { /* the quiz still works without it */ }
}

// Whole numbers in the middle; one decimal near 0 and 100 so small progress
// on a big codebase (one chunk = ~0.2%) still shows instead of rounding to 0%.
function pctText(v) {
  if (v <= 0) return "0%";
  if (v >= 100) return "100%";
  if (v < 0.1) return "<0.1%";
  if (v > 99.9) return ">99.9%";
  if (v < 10 || v > 90) return `${parseFloat(v.toFixed(1))}%`;
  return `${Math.round(v)}%`;
}

function stackedBar(mastered, learning, cls = "") {
  const bar = el("div", { className: `stack ${cls}` },
    el("i", { className: "s-mastered" }),
    el("i", { className: "s-learning" }),
  );
  [mastered, learning].forEach((v, i) => {
    bar.children[i].style.width = `${v}%`;
    if (v > 0) bar.children[i].style.minWidth = "4px"; // keep tiny progress visible
  });
  return bar;
}

function renderMastery(m) {
  const hero = document.getElementById("heroMastery");
  if (hero) {
    hero.innerHTML = "";
    const ring = el("div", { className: "mini-ring" }, el("span", { textContent: pctText(m.mastered_pct) }));
    ring.style.setProperty("--p", m.mastered_pct);
    hero.append(ring, el("div", {},
      el("strong", { textContent: "Code mastered" }),
      el("small", { textContent: `${pctText(m.known_pct)} known` }),
    ));
  }

  const card = document.getElementById("mastery");
  if (!card) return;
  card.innerHTML = "";

  const stat = (value, label, sub, cls) => el("div", { className: `m-stat ${cls}` },
    el("div", { className: "m-value", textContent: pctText(value) }),
    el("div", { className: "m-label", textContent: label }),
    el("div", { className: "m-sub", textContent: sub }),
  );
  const unseen = Math.max(0, 100 - m.mastered_pct - m.learning_pct);
  card.append(
    el("div", { className: "m-stats" },
      stat(m.mastered_pct, "Mastered", `Latest quiz finished with ${m.mastered_at}+`, "is-mastered"),
      stat(m.known_pct, "Known", "Your scores across all code, unseen = 0", "is-known"),
      stat(unseen, "Not seen yet", "Still waiting for a morning", "is-unseen"),
    ),
    stackedBar(m.mastered_pct, m.learning_pct, "big"),
    el("div", { className: "legend" },
      el("span", { html: '<i class="s-mastered"></i>Mastered' }),
      el("span", { html: '<i class="s-learning"></i>Learning' }),
      el("span", { html: '<i class="s-unseen"></i>Not seen' }),
    ),
  );

  const list = el("div", { className: "file-list" });
  const rows = showAllFiles ? m.files : m.files.slice(0, 8);
  for (const f of rows) {
    const known = el("span", { className: "f-pct", textContent: pctText(f.known_pct) });
    if (f.mastered_pct + f.learning_pct > 0) known.style.color = scoreColor(f.known_pct);
    const row = el("div", { className: "file-row", title: `Open ${f.file}` },
      el("span", { className: "f-name", textContent: f.name }),
      stackedBar(f.mastered_pct, f.learning_pct),
      known,
    );
    row.onclick = () => openFile({ file: f.file }, { line: 1 });
    list.append(row);
  }
  card.append(el("div", { className: "file-head" },
    el("span", { textContent: "By file" }), el("span", { textContent: "Known" })), list);

  if (m.files.length > 8) {
    const more = el("button", { className: "show-more", textContent: showAllFiles ? "Show fewer" : `Show all ${m.files.length} files` });
    more.onclick = () => { showAllFiles = !showAllFiles; renderMastery(m); };
    card.append(more);
  }
}

let currentChunk = null;

function renderChunk(day) {
  const { chunk } = day;
  currentChunk = chunk;
  const lineCount = chunk.code.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => chunk.start + i).join("\n");

  const code = el("code", { textContent: chunk.code });
  highlight(code, chunk.lang);

  const copyBtn = el("button", { title: "Copy code", html: `${icon("copy")}<span>Copy</span>` });
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(chunk.code); toast("Code copied"); }
    catch { toast("Couldn't copy"); }
  };

  const swapBtn = el("button", { title: "Get a different chunk", html: `${icon("swap")}<span>New chunk</span>` });
  swapBtn.onclick = async () => {
    if (Object.keys(day.answers).length && !confirm("You've already answered some questions today. Swap the chunk and lose them?")) return;
    showLoading("Picking a different chunk…");
    try { renderDay(await Quiz.reroll(day.round_id)); }
    catch (e) { showError(e.message); }
  };

  const fileTab = el("span", { className: "file-tab", html: icon("file") });
  fileTab.append(chunk.file.split("/").pop());

  const codeWrap = el("div", { className: "code-wrap", title: "Double-click a line to see it in the full file" },
    el("div", { className: "gutter", textContent: gutter }),
    el("pre", {}, code),
  );
  codeWrap.ondblclick = (e) => {
    const word = selectedWord();
    openFile(chunk, { line: lineAt(e, code, chunk.start, chunk.end), word });
  };
  return el("section", { className: "card code-card" },
    el("div", { className: "code-top" },
      fileTab,
      el("span", { className: "owner", textContent: isMarkup(chunk) ? chunk.owner.split(" › ").pop() : chunk.owner }),
      el("div", { className: "code-tools" }, copyBtn, swapBtn),
    ),
    codeWrap,
    el("div", { className: "code-foot" },
      el("span", { textContent: `${chunk.file}  ·  lines ${chunk.start}–${chunk.end}` }),
      el("span", { className: "dbl-hint", textContent: "Double-click any line to see it in the full file" }),
    ),
  );
}

// ---------------------------------------------------------------- full-file viewer

const LINE_PX = 22;  // must match the line-height in style.css
const PAD_PX = 16;   // top padding of the code block
let viewer = null;   // { file, lang, code, lines, chunk, line, word }

// The word the browser selected on double-click, if it looks like code.
function selectedWord() {
  const sel = window.getSelection();
  const text = (sel ? sel.toString() : "").trim();
  if (sel) sel.removeAllRanges();
  return /^[A-Za-z_@#$][\w.:@/+#$-]{0,60}$/.test(text) ? text.replace(/[.:]+$/, "") : null;
}

// Line number under the mouse inside a code block that starts at `firstLine`.
function lineAt(event, codeEl, firstLine, lastLine) {
  const top = codeEl.getBoundingClientRect().top;
  const n = firstLine + Math.floor((event.clientY - top - PAD_PX) / LINE_PX);
  return Math.min(Math.max(n, firstLine), lastLine);
}

function wordRegex(word) {
  return new RegExp(`(?<![\\w])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g");
}

function openFile(chunk, { line = null, word = null } = {}) {
  let data;
  try { data = Quiz.file(chunk.file); }
  catch (e) { toast(e.message, 4000); return; }

  const lines = data.code.split("\n");
  if (line == null && word) {  // came from a question: find the word, preferring today's chunk
    const re = wordRegex(word);
    const hits = lines.map((l, i) => (l.match(re) ? i + 1 : 0)).filter(Boolean);
    line = hits.find((n) => chunk.start && n >= chunk.start && n <= chunk.end) || hits[0] || null;
    if (!hits.length) toast(`"${word}" isn't in ${chunk.file.split("/").pop()}`, 3000);
  }
  viewer = { ...data, lines, chunk, line: line || chunk.start || 1, word };

  document.getElementById("fvName").innerHTML = icon("file");
  document.getElementById("fvName").append(data.file.split("/").pop());
  document.getElementById("fvPath").textContent = data.file;
  document.getElementById("fvGutter").textContent = lines.map((_, i) => i + 1).join("\n");
  const dialog = document.getElementById("fileDialog");
  if (!dialog.open) dialog.showModal();
  paintViewer(true);
}

function paintViewer(scroll) {
  const { lines, lang, chunk, line, word } = viewer;
  const code = document.getElementById("fvCode");
  code.textContent = viewer.code;
  highlight(code, lang);
  const count = word ? markWord(code, word) : 0;

  const bands = document.getElementById("fvBands");
  bands.innerHTML = "";
  const band = (from, to, cls) => {
    const b = el("div", { className: `band ${cls}` });
    b.style.top = `${PAD_PX + (from - 1) * LINE_PX}px`;
    b.style.height = `${(to - from + 1) * LINE_PX}px`;
    bands.append(b);
  };
  if (chunk.start) band(chunk.start, Math.min(chunk.end, lines.length), "band-chunk");
  band(line, line, "band-line");

  const foot = document.getElementById("fvFoot");
  foot.innerHTML = "";
  foot.append(`Line ${line}`);
  if (chunk.start) foot.append(` · today's chunk is tinted (lines ${chunk.start}–${chunk.end})`);
  if (word) {
    foot.append(" · ");
    foot.append(el("strong", { textContent: word }));
    foot.append(` appears ${count} time${count === 1 ? "" : "s"} in this file`);
  }
  foot.append(" · double-click another word or line to move the highlight");

  if (scroll) {
    const body = document.getElementById("fvBody");
    body.scrollTop = PAD_PX + (line - 1) * LINE_PX - body.clientHeight / 2 + LINE_PX;
  }
}

// Wrap every whole-word match of `word` in <mark>, working on hljs's text nodes.
function markWord(root, word) {
  const re = wordRegex(word);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index), el("mark", { className: "word", textContent: m[0] }));
      last = m.index + m[0].length;
      count++;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return count;
}

document.getElementById("fvBody").addEventListener("dblclick", (e) => {
  if (!viewer) return;
  const word = selectedWord();
  viewer.line = lineAt(e, document.getElementById("fvCode"), 1, viewer.lines.length);
  if (word) viewer.word = word;
  paintViewer(false);
});
document.getElementById("closeFile").onclick = () => document.getElementById("fileDialog").close();

// Double-clicking a code-looking word in a question or the feedback finds it in the file.
app.addEventListener("dblclick", (e) => {
  if (!currentChunk || !e.target.closest(".q-text, .feedback")) return;
  const word = selectedWord();
  if (word) openFile(currentChunk, { word });
});

function renderQuestion(q, i, saved) {
  const node = document.getElementById("questionTpl").content.firstElementChild.cloneNode(true);
  node.dataset.index = i;
  node.querySelector(".q-num").textContent = i + 1;
  const kind = node.querySelector(".q-kind");
  kind.textContent = KIND_LABELS[q.kind] || q.kind;
  kind.classList.add(`kind-${q.kind}`);
  node.querySelector(".q-text").textContent = q.question;

  const textarea = node.querySelector("textarea");
  const submit = node.querySelector(".submit");
  const mic = node.querySelector(".mic");
  const feedbackBox = node.querySelector(".feedback");

  const draftKey = `draft-${i}-${q.question.slice(0, 40)}`;
  textarea.value = saved ? saved.answer : store.get(draftKey) || "";
  textarea.oninput = () => { try { store.set(draftKey, textarea.value); } catch {} };
  textarea.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit.click(); }
  };

  if (saved) showFeedback(node, saved.feedback, false);
  setupMic(mic, textarea);

  submit.onclick = async () => {
    stopListening();
    const answer = textarea.value.trim();
    if (!answer) { textarea.focus(); return; }
    submit.disabled = true;
    submit.textContent = "Checking…";
    feedbackBox.hidden = true;
    try {
      const { feedback, ...daily } = await Quiz.grade(i, answer, currentDay.round_id);
      store.del(draftKey);
      setStatus(daily);
      if (daily.goal_just_met) toast(`🔥 Daily goal done! ${daily.streak}-day streak`, 4000);
      showFeedback(node, feedback, true);
      updateProgress();
      loadMastery();
    } catch (e) {
      feedbackBox.hidden = false;
      feedbackBox.innerHTML = "";
      feedbackBox.append(el("div", { className: "banner error", textContent: e.message }));
    } finally {
      submit.disabled = false;
      submit.textContent = node.classList.contains("done") ? "Check again" : "Check my answer";
    }
  };

  return node;
}

function showFeedback(node, fb, animate) {
  node.classList.add("done");
  node.dataset.score = fb.score;
  node.querySelector(".submit").textContent = "Check again";

  const color = scoreColor(fb.score);
  const badge = node.querySelector(".q-score");
  badge.hidden = false;
  badge.textContent = `${fb.score}/100`;
  badge.style.color = color;

  const box = node.querySelector(".feedback");
  box.hidden = false;
  box.innerHTML = "";

  const ring = el("div", { className: "score-ring" }, el("span", { textContent: fb.score }));
  ring.style.setProperty("--c", color);
  if (animate) requestAnimationFrame(() => requestAnimationFrame(() => ring.style.setProperty("--p", fb.score)));
  else ring.style.setProperty("--p", fb.score);

  const verdictEl = el("p", { className: "verdict", textContent: verdict(fb.score) });
  verdictEl.style.color = color;
  box.append(el("div", { className: "score-row" }, ring, el("div", {}, verdictEl, el("p", { className: "headline", textContent: fb.headline }))));

  const grid = el("div", { className: "fb-grid" });
  const section = (cls, iconName, title, items) => {
    if (!items || !items.length) return;
    const h = el("h4", { html: icon(iconName) });
    h.append(title);
    grid.append(el("div", { className: `fb-section ${cls}` }, h, el("ul", {}, ...items.map((t) => el("li", { textContent: t })))));
  };
  section("fb-right", "check", "What you got right", fb.got_right);
  section("fb-missed", "x", "What you missed", fb.missed);
  section("fb-further", "up", "How to go further", fb.go_further);
  box.append(grid);

  if (fb.model_answer) {
    const summary = el("summary", { html: icon("chevron") });
    summary.append("Show a model answer");
    box.append(el("details", {}, summary, el("p", { textContent: fb.model_answer })));
  }
}

function updateProgress() {
  const cards = [...document.querySelectorAll(".question")];
  const done = cards.filter((c) => c.classList.contains("done"));
  const segs = document.querySelectorAll(".seg");
  const firstOpen = cards.find((c) => !c.classList.contains("done"));

  cards.forEach((c, i) => {
    c.classList.toggle("current", c === firstOpen);
    segs[i].classList.toggle("now", c === firstOpen);
    segs[i].style.background = c.classList.contains("done") ? scoreColor(Number(c.dataset.score)) : "";
  });

  const avg = done.length ? Math.round(done.reduce((s, c) => s + Number(c.dataset.score), 0) / done.length) : null;
  document.getElementById("progressText").textContent = `This chunk: ${done.length} of ${cards.length} answered`;
  document.getElementById("progressAvg").textContent = avg == null ? "" : `Average ${avg}`;

  const box = document.getElementById("summary");
  box.innerHTML = "";
  if (!cards.length || done.length < cards.length) return;
  const msg = avg >= 85 ? "You really know this code. 🎯"
    : avg >= 60 ? "Solid. Skim the misses above once more."
    : "Good warm-up. Re-read the chunk with the feedback in mind.";
  const next = el("button", { className: "primary next-btn", html: `<span>Next chunk</span>${icon("chevron")}` });
  next.onclick = nextChunk;
  box.append(el("section", { className: "card summary" },
    el("div", { html: icon("trophy").replace("<svg", '<svg class="trophy"') }),
    el("p", { className: "eyebrow", textContent: "Chunk score" }),
    el("div", { className: "big", textContent: avg }),
    el("p", { className: "msg", textContent: msg }),
    el("p", { textContent: status.goal_met
      ? `🔥 Daily goal done, your ${status.streak}-day streak is safe. Keep going as long as you like.`
      : `Answer ${status.goal - status.today_answered} more today to keep your streak.` }),
    next,
  ));
}

// ---------------------------------------------------------------- voice input

function setupMic(button, textarea) {
  if (!SpeechRecognition) {
    button.disabled = true;
    button.title = "Voice input needs Chrome or Edge";
    return;
  }
  button.onclick = () => {
    if (activeRecognizer && activeRecognizer.button === button) { stopListening(); return; }
    stopListening();

    const rec = new SpeechRecognition();
    rec.lang = speechLang;
    rec.continuous = true;
    rec.interimResults = true;
    const base = textarea.value ? textarea.value.replace(/\s*$/, " ") : "";
    let finalText = "";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      textarea.value = base + finalText + interim;
      textarea.dispatchEvent(new Event("input"));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") toast("Microphone blocked. Allow it in the site settings.", 4000);
      else if (e.error === "network" || e.error === "service-not-allowed") {
        toast("Voice input doesn't work in this browser. Open the site in Microsoft Edge or Chrome.", 6000);
      }
      stopListening();
    };
    rec.onend = () => { if (activeRecognizer && activeRecognizer.rec === rec) stopListening(); };

    rec.start();
    activeRecognizer = { rec, button };
    button.classList.add("listening");
    button.querySelector("span").textContent = "Stop";
  };
}

function stopListening() {
  if (!activeRecognizer) return;
  const { rec, button } = activeRecognizer;
  activeRecognizer = null;
  try { rec.stop(); } catch {}
  button.classList.remove("listening");
  button.querySelector("span").textContent = "Speak";
}

function addLanguagePicker() {
  if (!SpeechRecognition) return;
  const select = el("select", { className: "lang", title: "Voice input language" },
    el("option", { value: "en-US", textContent: "🎙 English" }),
    el("option", { value: "he-IL", textContent: "🎙 עברית" }),
  );
  select.value = speechLang;
  select.onchange = () => { speechLang = select.value; try { store.set("speechLang", speechLang); } catch {} };
  document.querySelector(".top-actions").prepend(select);
}

// ---------------------------------------------------------------- history

function openHistory() {
  const dialog = document.getElementById("historyDialog");
  const list = document.getElementById("historyList");
  list.innerHTML = "";
  dialog.showModal();
  const rows = Quiz.history();
  if (!rows.length) list.append(el("p", { className: "empty", textContent: "Nothing yet. Today is day one." }));
  for (const r of rows) {
    const when = new Date(r.date + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const bar = el("div", { className: "h-bar" }, el("i"));
    if (r.avg != null) Object.assign(bar.firstChild.style, { width: `${r.avg}%`, background: scoreColor(r.avg) });
    const score = el("span", { className: "h-score", textContent: r.avg == null ? "–" : r.avg });
    if (r.avg != null) score.style.color = scoreColor(r.avg);
    list.append(el("div", { className: "h-row" },
      el("div", {},
        el("strong", { textContent: (r.title || "Untitled") + (r.rounds > 1 ? ` + ${r.rounds - 1} more` : "") }),
        el("small", { textContent: `${r.goal_met ? "🔥" : "○"} ${when} · ${r.answered} answered · ${r.rounds} chunk${r.rounds === 1 ? "" : "s"}` }),
      ),
      score,
      bar,
    ));
  }
}

// ---------------------------------------------------------------- boot

function showLoading(text) {
  app.innerHTML = "";
  app.append(el("div", { className: "loading" }, el("div", { className: "spinner" }), el("p", { textContent: text })));
}

function showError(message) {
  app.innerHTML = "";
  const retry = el("button", { textContent: "Try again" });
  retry.onclick = () => boot();
  app.append(el("div", { className: "banner error", textContent: message }), el("p", {}, retry));
}

document.getElementById("historyBtn").onclick = openHistory;
document.getElementById("closeHistory").onclick = () => document.getElementById("historyDialog").close();
addLanguagePicker();

async function boot() {
  showLoading("Loading…");
  let ok = false;
  try { ok = await Session.load(); } catch {}
  if (ok) keepForever();
  if (!ok) { location.replace("/review-deck/"); return; }  // sign-in lives in Review Deck
  setLoggedIn(true);
  showLoading("Picking today's code and writing your questions…");
  const file = new URLSearchParams(location.search).get("file");  // Review Deck: "Quiz me on this screen"
  if (file) history.replaceState(null, "", location.pathname);   // a reload goes back to the normal quiz
  try { renderDay(await (file ? Quiz.forFile(file) : Quiz.today())); }
  catch (e) { showError(e.message); }
}

boot();
