// Turns an uploaded folder / set of files into [{ path, lang, code }] - source code only.

const SOURCE_LANGS = {
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "groovy", gradle: "groovy",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", vue: "xml", svelte: "xml",
  py: "python", rb: "ruby", php: "php", go: "go", rs: "rust", swift: "swift", dart: "dart",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp",
  m: "objectivec", mm: "objectivec", lua: "lua", r: "r", jl: "julia", ex: "elixir", exs: "elixir",
  sh: "bash", ps1: "powershell", sql: "sql",
  html: "xml", htm: "xml", xml: "xml", css: "css", scss: "scss", less: "less",
};

// Folders that hold dependencies, build output or tooling - never the student's own code.
const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", "bower_components", "vendor", "build", "dist", "out", "target",
  ".gradle", ".idea", ".vscode", ".vs", "venv", ".venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache",
  "bin", "obj", "Pods", "DerivedData", ".next", ".nuxt", ".svelte-kit", "coverage", ".dart_tool",
  "generated", "intermediates", ".cxx", "site-packages", ".expo", ".angular", ".cache", "tmp",
]);

const MAX_FILE_BYTES = 300 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 3000;

const SECRET_RE = /AIza[0-9A-Za-z_\-]{30,}|AQ\.[0-9A-Za-z_\-]{30,}|sk-ant-[0-9A-Za-z_\-]+|sk-[0-9A-Za-z]{32,}|gh[pousr]_[0-9A-Za-z]{30,}/g;

// Never show or send API keys that are hard-coded in the project.
function redactSecrets(code) {
  return code.replace(SECRET_RE, "<API_KEY>");
}

function langFor(path) {
  const name = path.split("/").pop();
  if (/\.min\.(js|css)$/.test(name) || /(^|\.)(lock|map)$/.test(name) || name === "package-lock.json") return null;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const lang = SOURCE_LANGS[ext];
  if (!lang) return null;
  // Android res/: only hand-written layouts, values and the manifest - not icons, drawables or rules
  const parts = path.split("/");
  const res = parts.lastIndexOf("res");
  if (ext === "xml" && res >= 0 && res < parts.length - 2 && !/^(layout|values|menu|navigation)/.test(parts[res + 1])) return null;
  return lang;
}

function skippedDir(path) {
  return path.split("/").slice(0, -1).some((part) => SKIP_DIRS.has(part) || (part.startsWith(".") && part.length > 1));
}

// Every File from a drag-and-drop, walking into dropped folders.
async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((ok, fail) => entry.file(ok, fail));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) return;
      const reader = entry.createReader();
      let batch;
      do {  // readEntries returns at most 100 at a time
        batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}

function filesFromInput(fileList) {
  return [...fileList].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
}

// [{file, path}] -> { name, files: [{path, lang, code}], skipped, lines }
async function readProject(items) {
  const picked = [];
  let total = 0, skipped = 0;
  for (const { file, path } of items.sort((a, b) => a.path.localeCompare(b.path))) {
    const lang = langFor(path);
    if (!lang || skippedDir(path) || file.size > MAX_FILE_BYTES || file.size === 0) { skipped++; continue; }
    if (picked.length >= MAX_FILES || total + file.size > MAX_TOTAL_BYTES) { skipped++; continue; }
    const text = await file.text();
    if (text.includes("\u0000")) { skipped++; continue; }  // binary
    total += file.size;
    picked.push({ path, lang, code: redactSecrets(text.replace(/\r\n?/g, "\n")) });
  }

  // a dropped/picked folder gives every path the same first segment - use it as the project name
  const roots = new Set(picked.map((f) => f.path.split("/")[0]));
  const nested = picked.length && picked.every((f) => f.path.includes("/"));
  const name = nested && roots.size === 1 ? [...roots][0] : null;
  if (name) for (const f of picked) f.path = f.path.slice(name.length + 1);

  const lines = picked.reduce((n, f) => n + f.code.split("\n").length, 0);
  return { name, files: picked, skipped, lines };
}

// Most common non-markup language, for the AI prompt ("a Kotlin project called ...").
const LANG_NAMES = {
  java: "Java", kotlin: "Kotlin", scala: "Scala", groovy: "Groovy", javascript: "JavaScript", typescript: "TypeScript",
  python: "Python", ruby: "Ruby", php: "PHP", go: "Go", rust: "Rust", swift: "Swift", dart: "Dart", c: "C", cpp: "C++",
  csharp: "C#", objectivec: "Objective-C", lua: "Lua", r: "R", julia: "Julia", elixir: "Elixir", bash: "shell",
  powershell: "PowerShell", sql: "SQL", xml: "HTML/XML", css: "CSS", scss: "SCSS", less: "LESS",
};

function mainLanguage(files) {
  const lines = {};
  for (const f of files) lines[f.lang] = (lines[f.lang] || 0) + f.code.split("\n").length;
  const ranked = Object.entries(lines).sort((a, b) => b[1] - a[1]);
  const code = ranked.find(([l]) => !["xml", "css", "scss", "less"].includes(l)) || ranked[0];
  return code ? LANG_NAMES[code[0]] || code[0] : "code";
}
