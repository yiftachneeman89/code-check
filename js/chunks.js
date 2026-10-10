// Splits any project into quiz-sized chunks: whole functions where we can find them,
// otherwise runs of lines cut at blank lines. A port of the chunker in server.py.

const MIN_LINES = 8, MAX_LINES = 45;
const MIN_XML_LINES = 12;
const MIN_WINDOW = 12, MAX_WINDOW = 40;

const MARKUP = new Set(["xml", "css", "scss", "less"]);
const BRACE_LANGS = new Set([
  "java", "kotlin", "scala", "groovy", "javascript", "typescript", "php", "go", "rust", "swift", "dart",
  "c", "cpp", "csharp", "objectivec",
]);

// ---------------------------------------------------------------- helpers

// Remove string/char literals and // comments so brace counting isn't fooled.
function stripNoise(line) {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .split("//")[0];
}

function depthDelta(line) {
  const s = stripNoise(line);
  return (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
}

// Index of the line where the brace block opened at/after `start` closes.
function blockEnd(lines, start) {
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    const s = stripNoise(lines[i]);
    // a header that never opens a block: a one-line `fun f() = x`, a declaration, or the next function
    if (!opened && (i - start > 6 || (i > start && functionName(lines[i])) || /;\s*$/.test(s))) return null;
    if (s.includes("{")) opened = true;
    depth += depthDelta(lines[i]);
    if (opened && depth <= 0) return i;
  }
  return null;
}

const LEADING_RE = /^\s*(\/\/|\*|\/\*|@|#(?![a-z]*include|!)|--)/;

// Pull comment/annotation/decorator lines directly above `start` into the chunk.
function withLeadingComments(lines, start, floor) {
  while (start - 1 > floor && LEADING_RE.test(lines[start - 1])) start--;
  return start;
}

function dedent(text) {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

// Chunks made only of comments, braces and trivial lines have nothing worth quizzing on.
const TRIVIAL_RE = /^(|\/\/.*|\/\*.*|\*.*|#.*|@\w+(\(.*\))?|[\s{}()\[\];,]*|return( \w+)?;?|super\.\w+\(.*\);?|setContentView\(.*\);|EdgeToEdge\.enable\(this\);|pass|end)$/;

function isBoilerplate(code) {
  return code.split("\n").filter((l) => !TRIVIAL_RE.test(l.trim())).length < 3;
}

function makeChunk(file, lines, s, e, owner) {
  return {
    id: `${file.path}:${s + 1}`,
    file: file.path,
    start: s + 1,
    end: e + 1,
    owner,
    lang: file.lang,
    code: dedent(lines.slice(s, e + 1).join("\n")),
  };
}

// Runs of MIN_WINDOW..MAX_WINDOW lines between `from` and `to` (inclusive), cut at blank lines.
function lineWindows(lines, from, to, owner) {
  const out = [];
  let s = from;
  while (s <= to) {
    while (s <= to && /^[\s})\];,]*$/.test(lines[s])) s++;  // don't start on blank lines or closing braces
    if (s > to) break;
    let e = Math.min(s + MAX_WINDOW - 1, to);
    if (e < to) {  // back up to the last blank line that still leaves a decent window
      for (let k = e; k >= s + MIN_WINDOW; k--) if (!lines[k].trim()) { e = k - 1; break; }
    }
    if (e - s + 1 >= MIN_WINDOW) out.push([s, e, owner]);
    s = e + 1;
  }
  return out;
}

// ---------------------------------------------------------------- brace languages

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "do", "try", "when",
  "synchronized", "using", "lock", "foreach", "elseif", "match", "loop", "with", "typeof", "sizeof", "assert", "throw"]);
const TYPE_RE = /\b(?:class|interface|enum|struct|object|trait|impl|protocol|extension|namespace|record)\s+([A-Za-z_]\w*)/;
const FUNC_KEYWORD_RE = /\b(?:function|fun|func|fn|def)\s*\*?\s*(?:\([^)]*\)\s*)?(?:<[^>]*>\s*)?([A-Za-z_$][\w$]*)\s*[<(]/;
const ARROW_RE = /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const CALLISH_RE = /(?:^|[\s*&])([A-Za-z_$~][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;
const PROP_FUNC_RE = /^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/;

// Name of the function a line starts, or null.
function functionName(line) {
  const s = stripNoise(line).trim();
  if (!s || s.startsWith("*") || s.startsWith("#") || /;\s*$/.test(s)) return null;
  let m = s.match(FUNC_KEYWORD_RE) || s.match(ARROW_RE) || s.match(PROP_FUNC_RE);
  if (m) return m[1];
  if (/=[^=>]|\bclass\b|\binterface\b/.test(s.split("(")[0])) return null;  // assignment / type header
  m = s.match(CALLISH_RE);
  if (m && !CONTROL.has(m[1]) && /^[\w@$~<>\[\],.?*&:\s]*$/.test(s.slice(0, m.index + m[0].indexOf(m[1])))) {
    // a declaration has something before the name (a return type / modifiers) or is a method in a class body
    return m[1];
  }
  return null;
}

// Split a long function body into self-contained runs of statements.
function statementWindows(lines, bodyStart, bodyEnd, owner) {
  const starts = [];
  let depth = 0;
  for (let j = bodyStart; j < bodyEnd; j++) {
    const t = lines[j].trim();
    if (depth === 0 && t && !/^(\/\/|\*|\/\*|\}|#)/.test(t)) starts.push(j);
    depth += depthDelta(lines[j]);
  }
  const groups = [];
  let cur = [];
  for (const s of starts) {
    const prev = lines[s - 1].trim();
    if (cur.length && s > bodyStart && (!prev || prev.startsWith("//"))) { groups.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) groups.push(cur);

  const out = [];
  for (const g of groups) {
    const first = withLeadingComments(lines, g[0], bodyStart - 1);
    let end = g[g.length - 1];
    depth = 0;
    for (let k = end; k < bodyEnd; k++) {
      depth += depthDelta(lines[k]);
      end = k;
      const next = k + 1 < bodyEnd ? lines[k + 1].trim() : "";
      if (depth <= 0 && (/[;}]\s*$/.test(stripNoise(lines[k])) || !next)) break;
    }
    const n = end - first + 1;
    if (n >= MIN_LINES && n <= MAX_LINES) out.push([first, end, owner]);
    else if (n > MAX_LINES) out.push(...lineWindows(lines, first, end, owner));
  }
  return out;
}

function braceChunks(lines) {
  const found = [];
  const types = [];  // [name, endLine] of enclosing classes/structs
  let i = 0;
  while (i < lines.length) {
    while (types.length && i > types[types.length - 1][1]) types.pop();
    const line = lines[i];
    const t = line.match(TYPE_RE);
    if (t && !functionName(line)) {
      const end = blockEnd(lines, i);
      if (end != null) types.push([t[1], end]);
      i++;
      continue;
    }
    const name = functionName(line);
    const end = name ? blockEnd(lines, i) : null;
    if (end != null && end > i) {
      const cls = types.length ? types[types.length - 1][0] : null;
      const owner = cls ? `${cls}.${name}()` : `${name}()`;
      const start = withLeadingComments(lines, i, -1);
      const n = end - start + 1;
      if (n >= MIN_LINES && n <= MAX_LINES) found.push([start, end, owner]);
      else if (n > MAX_LINES) {
        let body = i;  // the signature can span lines - the body starts after the line that opens it
        while (body < end && !stripNoise(lines[body]).includes("{")) body++;
        found.push(...statementWindows(lines, body + 1, end, owner));
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return found;
}

// ---------------------------------------------------------------- Python (indentation)

const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;

function pythonChunks(lines) {
  const found = [];
  const types = [];  // [name, indent]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    while (types.length && ind <= types[types.length - 1][1]) types.pop();
    const cls = line.match(/^\s*class\s+(\w+)/);
    if (cls) { types.push([cls[1], ind]); continue; }
    const fn = line.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (!fn) continue;

    let h = i;  // the signature may span lines - the body starts after the line ending in ':'
    while (h < lines.length - 1 && !/:\s*(#.*)?$/.test(lines[h])) h++;
    let end = h;
    for (let k = h + 1; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      if (indentOf(lines[k]) <= ind) break;
      end = k;
    }
    const owner = types.length ? `${types[types.length - 1][0]}.${fn[1]}()` : `${fn[1]}()`;
    const start = withLeadingComments(lines, i, -1);
    const n = end - start + 1;
    if (n >= MIN_LINES && n <= MAX_LINES) found.push([start, end, owner]);
    else if (n > MAX_LINES) found.push(...lineWindows(lines, h + 1, end, owner));
    i = end;  // nested defs are part of this chunk
  }
  return found;
}

// ---------------------------------------------------------------- XML / HTML

const XML_TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\w[^>]*>|<(\/?)([\w:.\-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const XML_ID_RE = /(?:android:(?:id|name)|\bid|\bname)="(?:@\+?id\/)?([^"]+)"/;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// Elements with their 0-based start/end lines, children nested.
function xmlTree(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const root = { children: [] };
  const stack = [root];
  for (const m of text.matchAll(XML_TOKEN_RE)) {
    const [, closing, name, attrs, selfClosing] = m;
    if (name == null) continue;  // comment / declaration
    if (closing) {
      // pop back to the matching open tag (tolerates unclosed HTML tags)
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) { stack.length = at + 1; stack.pop().end = lineAt(m.index + m[0].length - 1); }
      continue;
    }
    const ident = (attrs || "").match(XML_ID_RE);
    const node = { name, id: ident ? ident[1] : null, start: lineAt(m.index), end: lineAt(m.index + m[0].length - 1), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) stack.push(node);
    // skip over <script>/<style> bodies; their content isn't markup
    if (/^(script|style)$/i.test(name) && !selfClosing) {
      const close = text.indexOf(`</${name}`, m.index + m[0].length);
      if (close > 0) XML_TOKEN_RE.lastIndex = close;
    }
  }
  return root.children;
}

function xmlLeadingComment(lines, start) {
  let i = start - 1;
  if (i < 0 || !lines[i].trim().endsWith("-->")) return start;
  while (i >= 0 && !lines[i].includes("<!--")) i--;
  return Math.max(i, 0);
}

function xmlChunks(lines, fileName) {
  const found = [];
  const span = (n) => n.end - n.start + 1;
  const label = (n) => {
    const t = n.name.split(".").pop();
    return n.id ? `${fileName} › ${t} #${n.id}` : `${fileName} › ${t}`;
  };
  function flush(window, parent) {  // a run of neighbouring elements
    if (!window.length) return;
    const s = xmlLeadingComment(lines, window[0].start);
    const e = window[window.length - 1].end;
    if (e - s + 1 >= MIN_XML_LINES) found.push([s, e, label(window.length === 1 ? window[0] : parent)]);
    window.length = 0;
  }
  function visit(node) {
    if (span(node) <= MAX_LINES) {
      if (span(node) >= MIN_XML_LINES) found.push([xmlLeadingComment(lines, node.start), node.end, label(node)]);
      return;
    }
    const window = [];
    for (const child of node.children) {
      if (span(child) > MAX_LINES) { flush(window, node); visit(child); continue; }
      if (window.length && child.end - window[0].start + 1 > MAX_LINES) flush(window, node);
      window.push(child);
    }
    flush(window, node);
  }
  for (const top of xmlTree(lines.join("\n"))) visit(top);
  return found;
}

// ---------------------------------------------------------------- entry points

function fileChunks(file) {
  const lines = file.code.split("\n");
  const name = file.path.split("/").pop();
  let found = [];
  try {
    if (file.lang === "xml") found = xmlChunks(lines, name);
    else if (file.lang === "python") found = pythonChunks(lines);
    else if (BRACE_LANGS.has(file.lang)) found = braceChunks(lines);
  } catch { found = []; }
  if (!found.length) found = lineWindows(lines, 0, lines.length - 1, name);

  const seen = new Set();
  return found
    .map(([s, e, owner]) => makeChunk(file, lines, s, e, owner))
    .filter((c) => !seen.has(c.id) && seen.add(c.id) && !isBoilerplate(c.code));
}

function allChunks(files) {
  return files.flatMap(fileChunks);
}

const isMarkup = (chunk) => MARKUP.has(chunk.lang);
