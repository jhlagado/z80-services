#!/usr/bin/env node
// Converts a Deno project to Node 24 mechanically.
//
//   node tools/deno-to-node.mjs [options] [project-dir]
//
// The default is a dry run: it prints the planned changes as diffs, then a
// report of everything it could not convert or that needs review. --write
// applies the changes. Running it again on a converted project changes nothing.
// See tools/README.md for the conversion rules.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";

const TOOL_VERSIONS = {
  "@biomejs/biome": "^2.6.3",
  "@types/node": "^22.20.5",
  typescript: "^7.0.2",
};
const NODE_ENGINE = ">=22.18";
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);
const DENO_CONFIG = /^deno(\.[\w-]+)*\.jsonc?$/;
const TEST_GLOB = "**/{*_,*.,}test.{ts,mts,js,mjs}";

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2);
const options = {
  write: false,
  removeDenoConfig: false,
  diff: true,
  json: false,
  dir: ".",
};
for (const arg of argv) {
  if (arg === "--write") options.write = true;
  else if (arg === "--remove-deno-config") options.removeDenoConfig = true;
  else if (arg === "--no-diff") options.diff = false;
  else if (arg === "--json") options.json = true;
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      [
        "usage: node deno-to-node.mjs [options] [project-dir]",
        "",
        "  --write               apply the changes (default: dry run)",
        "  --remove-deno-config  delete deno.json, deno.jsonc, deno.lock and",
        "                        other deno.*.json files",
        "  --no-diff             print the report without diffs",
        "  --json                print the report as JSON",
        "",
      ].join("\n"),
    );
    process.exit(0);
  } else if (arg.startsWith("-")) {
    process.stderr.write(`unknown option: ${arg}\n`);
    process.exit(2);
  } else options.dir = arg;
}
const root = resolve(options.dir);

// ---------------------------------------------------------------- report

const findings = [];
function note(level, file, line, message) {
  const same = (f) =>
    f.level === level &&
    f.file === file &&
    f.line === line &&
    f.message === message;
  if (!findings.some(same)) findings.push({ level, file, line, message });
}
const LEVELS = {
  manual: "not converted; needs hand work",
  strip: "TypeScript that Node's type stripping rejects; not converted",
  review: "converted; behaviour may differ, check it",
  docs: "documentation mentions Deno",
};

// ---------------------------------------------------------------- files

let fileList;
function projectFiles() {
  fileList ??= listProjectFiles();
  return fileList;
}

function listProjectFiles() {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\0")
      .filter((path) => path && existsSync(join(root, path)))
      .sort();
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push(path);
      }
    };
    walk("");
    return files.sort();
  }
}

const ignoredCache = new Map();
function isGitIgnored(path) {
  if (!ignoredCache.has(path)) {
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", path], {
        cwd: root,
        stdio: "ignore",
      });
      ignored = true;
    } catch {}
    ignoredCache.set(path, ignored);
  }
  return ignoredCache.get(path);
}

function readJsonc(text) {
  // Strips comments and trailing commas outside strings.
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// ---------------------------------------------------------------- masking
//
// mask() returns a copy of the source of the same length in which comments,
// string contents, template text and regular-expression bodies are blanked,
// so that pattern matching only sees code. Template substitutions stay
// visible, with "${" and its closing "}" turned into " (" and ")".

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "await",
  "yield",
  "instanceof",
]);

function mask(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const stack = []; // "{" for code braces, "t" for template substitutions
  let i = 0;
  let last = ""; // last significant code character or word
  const n = src.length;
  const template = () => {
    // i is just past a backtick or a closing substitution brace
    const start = i;
    while (i < n) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") {
        blank(start, i);
        i++;
        last = "`";
        return;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        out[i] = " ";
        out[i + 1] = "(";
        i += 2;
        stack.push("t");
        last = "(";
        return;
      } else i++;
    }
    blank(start, n);
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
      last = "s";
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/") {
      const regex =
        last === "" ||
        "(,=:[!&|?{};+-*%<>~^".includes(last) ||
        REGEX_KEYWORDS.has(last);
      if (regex) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 2;
          else {
            if (src[j] === "[") cls = true;
            else if (src[j] === "]") cls = false;
            else if (src[j] === "/" && !cls) break;
            j++;
          }
        }
        blank(i + 1, j);
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        last = "s";
      } else {
        last = "/";
        i++;
      }
    } else if (c === "{") {
      stack.push("{");
      last = "{";
      i++;
    } else if (c === "}") {
      const top = stack.pop();
      if (top === "t") {
        out[i] = ")";
        i++;
        template();
      } else {
        last = "}";
        i++;
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      last = src.slice(i, j);
      i = j;
    } else if (/\s/.test(c)) i++;
    else {
      last = c;
      i++;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------- source

class Source {
  constructor(path, text) {
    this.path = path;
    this.text = text;
    this.code = mask(text);
    this.edits = [];
    this.imports = new Map(); // module -> Map(importedName -> localName)
    this.defaults = new Map(); // module -> localName
    this.typeImports = new Map(); // module -> Set(name)
    this.freed = new Set(); // names an import being removed no longer binds
    this.isTs = TS_EXTENSIONS.has(extname(path));
    this.lineStarts = [0];
    for (let k = 0; k < text.length; k++) {
      if (text[k] === "\n") this.lineStarts.push(k + 1);
    }
  }
  line(pos) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  note(level, pos, message) {
    note(level, this.path, this.line(pos), message);
  }
  // Replaces start..end. `text` is a string or a list of strings and spans
  // ({ start, end } of the original); edits inside a span still apply.
  edit(start, end, text) {
    const parts = Array.isArray(text) ? text : [text];
    if (parts.length === 1 && this.text.slice(start, end) === parts[0]) return;
    this.edits.push({ start, end, parts });
  }
  // True when start..end touches text that an edit discards.
  overlaps(start, end) {
    return this.edits.some(
      (e) =>
        start < e.end &&
        e.start < end &&
        !e.parts.some(
          (p) => typeof p !== "string" && p.start <= start && end <= p.end,
        ),
    );
  }
  render(from, to, edits) {
    // An edit belongs to the outermost edit containing it; insertions at an
    // edit's boundary stay outside it.
    const contains = (o, e) => {
      if (o === e || o.end === o.start) return false;
      if (e.start === e.end) return o.start < e.start && e.start < o.end;
      if (o.start === e.start && o.end === e.end)
        return edits.indexOf(o) < edits.indexOf(e);
      return o.start <= e.start && e.end <= o.end;
    };
    const inside = edits.filter((e) => from <= e.start && e.end <= to);
    const top = inside
      .filter((e) => !inside.some((o) => contains(o, e)))
      .sort((x, y) => x.start - y.start || x.end - y.end);
    let out = "";
    let cursor = from;
    for (const e of top) {
      if (e.start < cursor) {
        throw new Error(
          `${this.path}: overlapping edits at line ${this.line(e.start)}`,
        );
      }
      out += this.text.slice(cursor, e.start);
      const nested = inside.filter((o) => contains(e, o));
      for (const p of e.parts) {
        out += typeof p === "string" ? p : this.render(p.start, p.end, nested);
      }
      cursor = e.end;
    }
    return out + this.text.slice(cursor, to);
  }
  // Index of the bracket matching the opener at pos, in masked code.
  match(pos) {
    const open = this.code[pos];
    const close = { "(": ")", "[": "]", "{": "}" }[open];
    let depth = 0;
    for (let k = pos; k < this.code.length; k++) {
      const c = this.code[k];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) return c === close ? k : -1;
      }
    }
    return -1;
  }
  // Splits the argument list of the call whose "(" is at pos.
  args(pos) {
    const end = this.match(pos);
    if (end < 0) return undefined;
    const list = [];
    let depth = 0;
    let start = pos + 1;
    for (let k = pos + 1; k < end; k++) {
      const c = this.code[k];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) {
        list.push(this.span(start, k));
        start = k + 1;
      }
    }
    const tail = this.span(start, end);
    if (tail.text.trim() !== "" || list.length > 0) list.push(tail);
    return { open: pos, close: end, list: list.filter((a) => a.text !== "") };
  }
  span(start, end) {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(this.code[s])) s++;
    while (e > s && /\s/.test(this.code[e - 1])) e--;
    return { start: s, end: e, text: this.text.slice(s, e) };
  }
  // True when name is bound in the file other than by the import it would get.
  bound(name) {
    if (this.freed.has(name)) return false;
    const word = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g");
    for (const m of this.code.matchAll(word)) {
      if (!this.overlaps(m.index, m.index + name.length)) return true;
    }
    return false;
  }
  // Records that the file needs `name` from module; returns the local name.
  need(module, name, preferred = name) {
    const existing = this.existingImport(module, name);
    if (existing) return existing;
    if (!this.imports.has(module)) this.imports.set(module, new Map());
    const names = this.imports.get(module);
    if (names.has(name)) return names.get(name);
    let local = preferred;
    if (this.bound(local)) {
      local = `node${name[0].toUpperCase()}${name.slice(1)}`;
      this.note(
        "review",
        0,
        `"${name}" is already bound here; imported from ${module} as ${local}`,
      );
    }
    names.set(name, local);
    return local;
  }
  needDefault(module, preferred) {
    const existing = this.existingDefault(module);
    if (existing) return existing;
    if (this.defaults.has(module)) return this.defaults.get(module);
    let local = preferred;
    if (this.bound(local)) {
      local = `node${preferred[0].toUpperCase()}${preferred.slice(1)}`;
      this.note(
        "review",
        0,
        `"${preferred}" is already bound here; imported from ${module} as ${local}`,
      );
    }
    this.defaults.set(module, local);
    return local;
  }
  needType(module, name) {
    if (this.existingImport(module, name)) return;
    if (!this.typeImports.has(module)) this.typeImports.set(module, new Set());
    const names = this.typeImports.get(module);
    names.add(name);
  }
  importStatements() {
    const list = [];
    const re =
      /(?<![\w$.])import\s+(type\s+)?([\w$]+\s*,?\s*)?(\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*(from\s*)?(["'])([^"'\n]*)\5(\s*(?:with|assert)\s*\{[^}]*\})?[ \t]*;?/dg;
    for (const m of this.code.matchAll(re)) {
      // The module specifier is blanked in masked code; read it from text.
      const [specStart, quote] = m.indices[6];
      const spec = this.text.slice(specStart, quote);
      list.push({
        start: m.index,
        end: m.index + m[0].length,
        text: this.text.slice(m.index, m.index + m[0].length),
        typeOnly: Boolean(m[1]),
        defaultName: m[2]?.replace(/[\s,]/g, "") || undefined,
        named: m[3]?.startsWith("{") ? m[3] : undefined,
        namespace: m[3]?.startsWith("*") ? m[3] : undefined,
        spec,
        specStart,
        specEnd: quote,
      });
    }
    return list;
  }
  existingImport(module, name) {
    for (const imp of this.importStatements()) {
      if (imp.spec !== module || imp.typeOnly || !imp.named) continue;
      for (const part of imp.named.slice(1, -1).split(",")) {
        const m = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (m && m[1] === name) return m[2] ?? m[1];
      }
    }
    return undefined;
  }
  existingDefault(module) {
    for (const imp of this.importStatements()) {
      if (imp.spec === module && !imp.typeOnly && imp.defaultName) {
        return imp.defaultName;
      }
    }
    return undefined;
  }
  // Applies queued imports and edits; returns the new text.
  result() {
    const statements = this.importStatements();
    const lines = [];
    const modules = new Set([
      ...this.defaults.keys(),
      ...this.imports.keys(),
      ...this.typeImports.keys(),
    ]);
    for (const module of [...modules].sort()) {
      const def = this.defaults.get(module);
      const names = [...(this.imports.get(module) ?? new Map())]
        .map(([n, l]) => (n === l ? n : `${n} as ${l}`))
        .sort();
      const types = [...(this.typeImports.get(module) ?? [])].sort();
      const existing = statements.find(
        (s) =>
          s.spec === module &&
          !s.typeOnly &&
          s.named &&
          !this.overlaps(s.start, s.end),
      );
      if (existing && (names.length || types.length)) {
        const inner = existing.named
          .slice(1, -1)
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        const merged = [...inner, ...names, ...types.map((t) => `type ${t}`)];
        const start = existing.start + existing.text.indexOf(existing.named);
        this.edit(
          start,
          start + existing.named.length,
          `{ ${[...new Set(merged)].join(", ")} }`,
        );
        if (def) lines.push(`import ${def} from "${module}";`);
        continue;
      }
      if (def) lines.push(`import ${def} from "${module}";`);
      if (names.length) {
        lines.push(`import { ${names.join(", ")} } from "${module}";`);
      }
      if (types.length) {
        lines.push(`import type { ${types.join(", ")} } from "${module}";`);
      }
    }
    if (lines.length) {
      let at;
      let gap = "";
      if (statements.length) at = statements[0].start;
      else {
        // after a shebang and leading comments
        const m = this.text.match(
          /^(#![^\n]*\n)?((\s*\/\/[^\n]*\n)|(\s*\/\*[\s\S]*?\*\/\s*\n))*/,
        );
        at = m ? m[0].length : 0;
        gap = this.text[at] === "\n" ? "" : "\n";
      }
      this.edits.push({
        start: at,
        end: at,
        parts: [`${lines.join("\n")}\n${gap}`],
      });
    }
    return this.render(0, this.text.length, this.edits);
  }
}

// Builds edit parts: interpolated spans stay spans, arrays are spread.
function P(strings, ...values) {
  const out = [];
  strings.forEach((text, i) => {
    out.push(text);
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
  });
  return out.filter((x) => x !== "");
}

// a, b, c as parts
function list(spans) {
  return spans.flatMap((x, i) => (i ? [", ", x] : [x]));
}

// ", a, b" as parts, for trailing optional arguments
function more(spans) {
  return spans.flatMap((x) => [", ", x]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- Deno APIs

const FS_PROMISES = "node:fs/promises";
const FS = "node:fs";

// Plain renames: Deno.name(args) -> fn(args), with fn imported from module.
const FS_CALLS = {
  mkdir: [FS_PROMISES, "mkdir"],
  mkdirSync: [FS, "mkdirSync"],
  copyFile: [FS_PROMISES, "copyFile"],
  copyFileSync: [FS, "copyFileSync"],
  rename: [FS_PROMISES, "rename"],
  renameSync: [FS, "renameSync"],
  readLink: [FS_PROMISES, "readlink"],
  readLinkSync: [FS, "readlinkSync"],
  realPath: [FS_PROMISES, "realpath"],
  realPathSync: [FS, "realpathSync"],
  chmod: [FS_PROMISES, "chmod"],
  chmodSync: [FS, "chmodSync"],
  truncate: [FS_PROMISES, "truncate"],
  truncateSync: [FS, "truncateSync"],
  utime: [FS_PROMISES, "utimes"],
  utimeSync: [FS, "utimesSync"],
  link: [FS_PROMISES, "link"],
  linkSync: [FS, "linkSync"],
};
const STAT_CALLS = {
  stat: [FS_PROMISES, "stat"],
  lstat: [FS_PROMISES, "lstat"],
  statSync: [FS, "statSync"],
  lstatSync: [FS, "lstatSync"],
};
const ERROR_CODES = {
  NotFound: "ENOENT",
  AlreadyExists: "EEXIST",
  PermissionDenied: "EACCES",
  IsADirectory: "EISDIR",
  NotADirectory: "ENOTDIR",
  NotEmpty: "ENOTEMPTY",
};
const FILE_INFO_PROPS = {
  isFile: "isFile()",
  isDirectory: "isDirectory()",
  isSymlink: "isSymbolicLink()",
};

function convertDeno(src) {
  const re = /(?<![\w$.])Deno\s*\.\s*([\w$]+)/g;
  for (const m of [...src.code.matchAll(re)]) {
    const start = m.index;
    if (src.overlaps(start, start + m[0].length)) continue;
    const name = m[1];
    const after = start + m[0].length;
    const rest = src.code.slice(after);
    const call = rest.match(/^\s*\(/);
    const open = call ? after + call[0].length - 1 : -1;
    const args = call ? src.args(open) : undefined;

    if (name === "test") convertTest(src, start, after);
    else if (name === "TestContext") {
      src.edit(start, after, "TestContext");
      src.needType("node:test", "TestContext");
    } else if (name === "readTextFile" || name === "readTextFileSync") {
      if (args?.list.length !== 1) {
        src.note("manual", start, `Deno.${name} with options`);
        continue;
      }
      const sync = name.endsWith("Sync");
      const fn = src.need(
        sync ? FS : FS_PROMISES,
        sync ? "readFileSync" : "readFile",
      );
      src.edit(start, args.close + 1, P`${fn}(${args.list[0]}, "utf8")`);
    } else if (name === "readFile" || name === "readFileSync") {
      if (args?.list.length !== 1) {
        src.note("manual", start, `Deno.${name} with options`);
        continue;
      }
      // Node returns a Buffer; Deno a plain Uint8Array. Copy to keep
      // equality, slicing and toString() behaving as before.
      const sync = name.endsWith("Sync");
      const fn = src.need(sync ? FS : FS_PROMISES, name);
      const inner = P`${fn}(${args.list[0]})`;
      const before = src.code.slice(0, start).match(/\bawait\s*$/);
      if (sync) src.edit(start, args.close + 1, P`new Uint8Array(${inner})`);
      else if (before) {
        src.edit(
          before.index,
          args.close + 1,
          P`new Uint8Array(await ${inner})`,
        );
      } else {
        src.edit(
          start,
          args.close + 1,
          P`${inner}.then((bytes) => new Uint8Array(bytes))`,
        );
      }
    } else if (
      name === "writeTextFile" ||
      name === "writeTextFileSync" ||
      name === "writeFile" ||
      name === "writeFileSync"
    ) {
      if (!args || args.list.length < 2) {
        src.note("manual", start, `Deno.${name} call not understood`);
        continue;
      }
      const sync = name.endsWith("Sync");
      let fn = sync ? "writeFileSync" : "writeFile";
      if (args.list.length > 2) {
        const opts = args.list[2].text.replace(/\s/g, "");
        if (opts === "{append:true}")
          fn = sync ? "appendFileSync" : "appendFile";
        else {
          src.note(
            "manual",
            start,
            `Deno.${name} options ${args.list[2].text}`,
          );
          continue;
        }
      }
      const local = src.need(sync ? FS : FS_PROMISES, fn);
      src.edit(
        start,
        args.close + 1,
        P`${local}(${args.list[0]}, ${args.list[1]})`,
      );
    } else if (name in FS_CALLS) {
      if (!args) {
        src.note("manual", start, `Deno.${name} used without a call`);
        continue;
      }
      const [module, fn] = FS_CALLS[name];
      src.edit(start, after, src.need(module, fn));
    } else if (name === "remove" || name === "removeSync") {
      if (!args) {
        src.note("manual", start, `Deno.${name} used without a call`);
        continue;
      }
      const sync = name.endsWith("Sync");
      src.edit(
        start,
        after,
        src.need(sync ? FS : FS_PROMISES, sync ? "rmSync" : "rm"),
      );
      const recursive =
        args.list[1]?.text.replace(/\s/g, "") === "{recursive:true}";
      if (!recursive) {
        src.note(
          "review",
          start,
          `Deno.${name} without recursive also removes empty directories; Node's rm does not`,
        );
      }
    } else if (name === "symlink" || name === "symlinkSync") {
      if (!args || args.list.length > 2) {
        src.note("manual", start, `Deno.${name} with options`);
        continue;
      }
      const sync = name.endsWith("Sync");
      src.edit(start, after, src.need(sync ? FS : FS_PROMISES, name));
    } else if (name in STAT_CALLS) {
      if (!args) {
        src.note("manual", start, `Deno.${name} used without a call`);
        continue;
      }
      const [module, fn] = STAT_CALLS[name];
      src.edit(start, after, src.need(module, fn));
      fixFileInfo(src, start, args.close + 1, `Deno.${name}`);
    } else if (name === "readDir" || name === "readDirSync") {
      convertReadDir(src, start, name, args);
    } else if (name === "errors") {
      const m2 = rest.match(/^\s*\.\s*(\w+)/);
      const code = m2 && ERROR_CODES[m2[1]];
      const left = src.code
        .slice(0, start)
        .match(/(?<![\w$.])([\w$]+(?:\??\.[\w$]+)*)\s+instanceof\s*$/);
      if (!code || !left) {
        src.note("manual", start, `Deno.errors${m2 ? `.${m2[1]}` : ""}`);
        continue;
      }
      const subject = left[1];
      const cast = src.isTs
        ? `(${subject} as NodeJS.ErrnoException | null)`
        : subject;
      let text = `${cast}?.code === "${code}"`;
      const end = after + m2[0].length;
      const enclosed =
        /\(\s*$/.test(src.code.slice(0, left.index)) &&
        /^\s*\)/.test(src.code.slice(end));
      if (!enclosed) text = `(${text})`;
      src.edit(left.index, end, text);
      if (m2[1] === "PermissionDenied") {
        src.note("review", start, "PermissionDenied may also be EPERM in Node");
      }
    } else if (name === "args") {
      src.edit(start, after, "process.argv.slice(2)");
    } else if (name === "exit") {
      src.edit(start, after, "process.exit");
    } else if (name === "cwd" || name === "chdir" || name === "memoryUsage") {
      src.edit(start, after, `process.${name}`);
    } else if (name === "pid" || name === "ppid") {
      src.edit(start, after, `process.${name}`);
    } else if (name === "execPath") {
      if (!args) {
        src.note("manual", start, "Deno.execPath used without a call");
        continue;
      }
      src.edit(start, args.close + 1, "process.execPath");
      src.note("review", start, "Deno.execPath() now names the node binary");
    } else if (name === "hostname" && args) {
      src.edit(start, after, src.need("node:os", "hostname"));
    } else if (name === "inspect") {
      src.edit(start, after, src.need("node:util", "inspect"));
    } else if (name === "env") convertEnv(src, start, after);
    else
      src.note(
        "manual",
        start,
        `Deno.${name} has no mechanical Node equivalent`,
      );
  }
  for (const m of src.code.matchAll(/(?<![\w$.])Deno(?![\w$])(?!\s*\.)/g)) {
    src.note("manual", m.index, "bare reference to the Deno global");
  }
}

function convertEnv(src, start, after) {
  const m = src.code.slice(after).match(/^\s*\.\s*(\w+)\s*\(/);
  if (!m) {
    src.note("manual", start, "Deno.env used without a method call");
    return;
  }
  const args = src.args(after + m[0].length - 1);
  const a = args.list;
  const end = args.close + 1;
  const statement =
    /^\s*(;|\n|$)/.test(src.code.slice(end)) &&
    /(^|[;{}\n])\s*$/.test(src.code.slice(0, start));
  switch (m[1]) {
    case "get":
      src.edit(start, end, P`process.env[${a[0]}]`);
      return;
    case "has":
      src.edit(start, end, P`Object.hasOwn(process.env, ${a[0]})`);
      return;
    case "toObject":
      src.edit(start, end, "{ ...process.env }");
      return;
    case "set":
      if (statement)
        return src.edit(start, end, P`process.env[${a[0]}] = ${a[1]}`);
      break;
    case "delete":
      if (statement)
        return src.edit(start, end, P`delete process.env[${a[0]}]`);
      break;
  }
  src.note("manual", start, `Deno.env.${m[1]}`);
}

// Rewrites FileInfo property reads (.isFile and friends) on a stat result.
function fixFileInfo(src, start, callEnd, what) {
  // (await Deno.stat(p)).isFile or Deno.statSync(p).isFile
  const direct = src.code
    .slice(callEnd)
    .match(/^\s*\)?\s*\.\s*(isFile|isDirectory|isSymlink)(?![\w$])(?!\s*\()/);
  if (direct) {
    const prop = callEnd + direct[0].length - direct[1].length;
    src.edit(prop, prop + direct[1].length, FILE_INFO_PROPS[direct[1]]);
    return;
  }
  const decl = src.code
    .slice(0, start)
    .match(/(?:const|let|var)\s+([\w$]+)(\s*:\s*[^=]+)?\s*=\s*(await\s+)?$/);
  if (!decl) {
    const statement =
      /^[ \t]*(;|\n|$)/.test(src.code.slice(callEnd)) &&
      /(^|[;{}])\s*(await\s+)?$/.test(src.code.slice(0, start));
    if (!statement) {
      src.note(
        "review",
        start,
        `${what} result: Node Stats use methods (isFile()), not properties`,
      );
    }
    return;
  }
  if (decl[2])
    src.note("review", start, `${what} result has a Deno type annotation`);
  const name = decl[1];
  const scopeEnd = blockEnd(src, start);
  rewriteEntryProps(src, name, callEnd, scopeEnd, what);
}

function blockEnd(src, pos) {
  let depth = 0;
  for (let k = pos; k < src.code.length; k++) {
    const c = src.code[k];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return src.code.length;
}

function rewriteEntryProps(src, name, from, to, what) {
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g");
  let escapes = false;
  for (const m of src.code.matchAll(re)) {
    if (m.index < from) continue;
    if (m.index >= to) break;
    const end = m.index + m[0].length;
    const tail = src.code.slice(end);
    const prop = tail.match(/^\s*\.\s*([\w$]+)/);
    if (
      prop &&
      prop[1] in FILE_INFO_PROPS &&
      !/^\s*\(/.test(tail.slice(prop[0].length))
    ) {
      const at = end + prop[0].length - prop[1].length;
      src.edit(at, at + prop[1].length, FILE_INFO_PROPS[prop[1]]);
    } else if (!prop && !/^\s*=(?!=)/.test(tail)) escapes = true;
  }
  if (escapes) {
    src.note(
      "review",
      from,
      `${what} result "${name}" is passed on; Node uses isFile()/isDirectory()/isSymbolicLink() methods`,
    );
  }
}

function convertReadDir(src, start, name, args) {
  const sync = name === "readDirSync";
  const head = src.code
    .slice(0, start)
    .match(/for\s*(await\s*)?\(\s*(const|let|var)\s+([\w$]+)\s+of\s*$/);
  if (args?.list.length !== 1 || !head || Boolean(head[1]) === sync) {
    src.note(
      "manual",
      start,
      `Deno.${name} outside a for${sync ? "" : " await"}...of loop`,
    );
    return;
  }
  const fn = src.need(
    sync ? FS : FS_PROMISES,
    sync ? "readdirSync" : "readdir",
  );
  const call = P`${fn}(${args.list[0]}, { withFileTypes: true })`;
  if (sync) src.edit(start, args.close + 1, call);
  else {
    // drop "await" after "for", move it before the call
    const forPos = head.index;
    const awaitAt = forPos + head[0].indexOf("await");
    src.edit(
      awaitAt,
      awaitAt + 5 + (src.text[awaitAt + 5] === " " ? 1 : 0),
      "",
    );
    src.edit(start, args.close + 1, P`await ${call}`);
  }
  const loopClose = src.match(src.code.indexOf("(", head.index));
  const body =
    src.code.slice(loopClose + 1).match(/^\s*/)[0].length + loopClose + 1;
  const end =
    src.code[body] === "{" ? src.match(body) : statementEnd(src, body);
  rewriteEntryProps(src, head[3], loopClose + 1, end, `Deno.${name} entry`);
}

function statementEnd(src, pos) {
  let depth = 0;
  for (let k = pos; k < src.code.length; k++) {
    const c = src.code[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return k;
      depth--;
    } else if ((c === ";" || c === "\n") && depth === 0) return k;
  }
  return src.code.length;
}

// Deno.test forms:
//   Deno.test(name, fn)             -> test(name, fn)
//   Deno.test(fn)                   -> test(fn)
//   Deno.test(name, options, fn)    -> test(name, nodeOptions, fn)
//   Deno.test(options, fn)          -> test(name, nodeOptions, fn)
//   Deno.test({ name, fn, ... })    -> test(name, nodeOptions, fn)
//   Deno.test.ignore / .only        -> test.skip / test.only
function convertTest(src, start, after) {
  let pos = after;
  let variant = "";
  const v = src.code.slice(after).match(/^\s*\.\s*(ignore|only)/);
  if (v) {
    variant = v[1] === "ignore" ? ".skip" : ".only";
    pos = after + v[0].length;
  }
  const call = src.code.slice(pos).match(/^\s*\(/);
  if (!call) {
    src.note("manual", start, "Deno.test used without a call");
    return;
  }
  const args = src.args(pos + call[0].length - 1);
  if (!args) {
    src.note("manual", start, "Deno.test call not understood");
    return;
  }
  const local = src.needDefault("node:test", "test");
  const list = args.list;
  const isObject = (a) => a && src.code[a.start] === "{";
  if (variant === ".only") onlyNote(src, start);

  let opts;
  let name;
  let fn;
  let fnSpan;
  let fnText;
  if (list.length <= 2 && isObject(list[0])) {
    opts = parseObject(src, list[0]);
    name = opts?.name;
    fn = list.length === 2 ? list[1] : opts?.fn;
    fnSpan = list.length === 2 ? list[1] : opts?.fnSpan;
    fnText = list.length === 2 ? list[1].text : opts?.fnText;
  } else if (list.length === 3 && isObject(list[1])) {
    opts = parseObject(src, list[1]);
    [name, , fn] = list;
    fnSpan = fn;
    fnText = fn.text;
  } else if (list.length === 1 || list.length === 2) {
    src.edit(start, pos, `${local}${variant}`);
    convertSteps(src, list[list.length - 1]);
    return;
  } else {
    src.note("manual", start, "Deno.test call not understood");
    return;
  }
  if (!opts) {
    src.note("manual", start, "Deno.test options not understood");
    return;
  }
  if (!fn) {
    src.note("manual", start, "Deno.test without fn");
    return;
  }
  const node = [];
  for (const [key, value] of Object.entries(opts.rest)) {
    if (key === "ignore") node.push(P`skip: ${value}`);
    else if (key === "only") {
      node.push(P`only: ${value}`);
      onlyNote(src, start);
    } else if (key.startsWith("sanitize")) continue;
    else if (key === "permissions") {
      src.note("manual", start, "per-test permissions dropped; Node has none");
    } else src.note("manual", start, `Deno.test option "${key}" dropped`);
  }
  const options = node.length
    ? P`{ ${node.flatMap((o, i) => (i ? [", ", ...o] : o))} }, `
    : [];
  const label = name === undefined ? [] : P`${name}, `;
  src.edit(
    start,
    args.close + 1,
    P`${local}${variant}(${label}${options}${fn})`,
  );
  if (fnSpan) convertSteps(src, fnSpan, fnText);
}

function onlyNote(src, pos) {
  src.note(
    "review",
    pos,
    "Node honours test.only only when run with --test-only",
  );
}

function parseObject(src, span) {
  const close = src.match(span.start);
  if (close !== span.end - 1) return undefined;
  const props = [];
  let depth = 0;
  let from = span.start + 1;
  for (let k = span.start + 1; k <= close; k++) {
    const c = src.code[k];
    if (k === close || (c === "," && depth === 0)) {
      const part = src.span(from, k);
      if (part.text) props.push(part);
      from = k + 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  // Values are spans of the original text, so edits inside them still apply.
  const rest = {};
  let name;
  let fn;
  let fnSpan;
  let fnText;
  for (const p of props) {
    const code = src.code.slice(p.start, p.end);
    let m = code.match(/^([\w$]+)\s*:/);
    if (m) {
      const value = src.span(p.start + m[0].length, p.end);
      if (m[1] === "name") name = value;
      else if (m[1] === "fn") {
        fn = fnSpan = value;
        fnText = value.text;
      } else rest[m[1]] = value;
      continue;
    }
    m = code.match(/^(async\s+)?(\*\s*)?([\w$]+)\s*\(/);
    if (m && m[3] === "fn") {
      // method shorthand: async fn(t) { ... } -> async function (t) { ... }
      const head = `${m[1] ?? ""}function${m[2] ? "*" : ""} `;
      fnSpan = src.span(p.start + m[0].length - 1, p.end);
      fn = [head, fnSpan];
      fnText = head + fnSpan.text;
      continue;
    }
    m = code.match(/^([\w$]+)$/);
    if (m) {
      if (m[1] === "name") name = "name";
      else if (m[1] === "fn") fn = fnText = "fn";
      else rest[m[1]] = m[1];
      continue;
    }
    return undefined;
  }
  return { name, fn, fnSpan, fnText, rest };
}

// t.step(name, fn) -> t.test(name, fn) for the context parameter of a test.
function convertSteps(src, fnSpan, fnText = fnSpan.text) {
  const m = fnText.match(
    /^(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(\s*([\w$]+)|^(?:async\s+)?([\w$]+)\s*=>/,
  );
  const param = m && (m[1] ?? m[2]);
  if (!param) return;
  const re = new RegExp(
    `(?<![\\w$.])${escapeRegExp(param)}\\s*\\.\\s*step(?=\\s*\\()`,
    "g",
  );
  const body = src.code.slice(fnSpan.start, fnSpan.end);
  for (const s of body.matchAll(re)) {
    const at = fnSpan.start + s.index;
    const dot = s[0].lastIndexOf("step");
    const open = src.code.indexOf("(", at + dot);
    const args = src.args(open);
    if (args?.list.length === 1 && src.code[args.list[0].start] === "{") {
      src.note("manual", at, "t.step with an options object");
      continue;
    }
    src.edit(at + dot, at + dot + 4, "test");
  }
}

// ---------------------------------------------------------------- std modules

const STD =
  /^(?:jsr:)?@std\/(\w+)(?:@[^/]*)?(\/[\w./-]*)?$|^https:\/\/deno\.land\/std(?:@[^/]*)?\/(\w+)\/([\w./-]*)$/;

const PATH_NAMES = {
  join: "join",
  resolve: "resolve",
  dirname: "dirname",
  basename: "basename",
  extname: "extname",
  relative: "relative",
  normalize: "normalize",
  isAbsolute: "isAbsolute",
  parse: "parse",
  format: "format",
  toNamespacedPath: "toNamespacedPath",
  SEPARATOR: "sep",
  SEP: "sep",
  DELIMITER: "delimiter",
};
const URL_NAMES = { fromFileUrl: "fileURLToPath", toFileUrl: "pathToFileURL" };

// assert function -> (args) => replacement text, using local name A for
// node:assert/strict. Returning undefined leaves the call for hand work.
const ASSERTS = {
  assert: (A, a) => P`${A}(${list(a)})`,
  assertEquals: (A, a) => P`${A}.deepStrictEqual(${list(a)})`,
  assertNotEquals: (A, a) => P`${A}.notDeepStrictEqual(${list(a)})`,
  assertStrictEquals: (A, a) => P`${A}.strictEqual(${list(a)})`,
  assertNotStrictEquals: (A, a) => P`${A}.notStrictEqual(${list(a)})`,
  assertMatch: (A, a) => P`${A}.match(${list(a)})`,
  assertNotMatch: (A, a) => P`${A}.doesNotMatch(${list(a)})`,
  assertFalse: (A, [x, ...m]) => P`${A}.ok(!(${x})${more(m)})`,
  assertExists: (A, [x, ...m]) => P`${A}.ok((${x}) != null${more(m)})`,
  assertInstanceOf: (A, [x, c, ...m]) =>
    P`${A}.ok((${x}) instanceof ${c}${more(m)})`,
  assertStringIncludes: (A, [s, t, ...m]) =>
    P`${A}.ok((${s}).includes(${t})${more(m)})`,
  assertGreater: (A, [x, y, ...m]) => P`${A}.ok((${x}) > (${y})${more(m)})`,
  assertGreaterOrEqual: (A, [x, y, ...m]) =>
    P`${A}.ok((${x}) >= (${y})${more(m)})`,
  assertLess: (A, [x, y, ...m]) => P`${A}.ok((${x}) < (${y})${more(m)})`,
  assertLessOrEqual: (A, [x, y, ...m]) =>
    P`${A}.ok((${x}) <= (${y})${more(m)})`,
  assertObjectMatch: (A, a) => P`${A}.partialDeepStrictEqual(${list(a)})`,
  fail: (A, a) => P`${A}.fail(${list(a)})`,
  unreachable: (A, a) =>
    a.length ? P`${A}.fail(${list(a)})` : P`${A}.fail("unreachable")`,
  assertThrows: (A, a, src) => throwsLike(A, "throws", a, src),
  assertRejects: (A, a, src) => throwsLike(A, "rejects", a, src),
};

function throwsLike(A, method, [fn, cls, msg, ...rest], src) {
  if (rest.length) return undefined;
  if (!cls) return P`${A}.${method}(${fn})`;
  if (!msg) return P`${A}.${method}(${fn}, ${cls})`;
  const e = src.isTs ? "(error: unknown)" : "(error)";
  return P`${A}.${method}(${fn}, ${e} => error instanceof ${cls} && error.message.includes(${msg}))`;
}

function convertImports(src, importMap) {
  for (const imp of src.importStatements()) {
    let spec = imp.spec;
    if (importMap[spec]) spec = importMap[spec];
    else {
      const prefix = Object.keys(importMap)
        .filter((k) => k.endsWith("/") && spec.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (prefix) spec = importMap[prefix] + spec.slice(prefix.length);
    }
    const std = spec.match(STD);
    if (std) {
      const module = std[1] ?? std[3];
      const sub = std[2] ?? `/${std[4]}`;
      if (
        module === "assert" ||
        (module === "testing" && /asserts/.test(sub))
      ) {
        convertAssertImport(src, imp);
      } else if (module === "path") convertPathImport(src, imp, sub);
      else if (module === "fs") convertFsImport(src, imp);
      else src.note("manual", imp.start, `import from ${imp.spec}`);
      continue;
    }
    if (spec.startsWith("npm:")) {
      const m = spec.match(/^npm:(@?[^@/]+(?:\/[^@/]+)?)(?:@([^/]+))?(\/.*)?$/);
      if (!m) {
        src.note("manual", imp.start, `import from ${imp.spec}`);
        continue;
      }
      src.edit(imp.specStart, imp.specEnd, `${m[1]}${m[3] ?? ""}`);
      npmDependencies.set(m[1], m[2] ? `^${m[2].replace(/^\^/, "")}` : "*");
      if (!m[2])
        src.note("review", imp.start, `npm dependency ${m[1]} has no version`);
      continue;
    }
    if (/^(jsr:|https?:)/.test(spec)) {
      src.note("manual", imp.start, `import from ${imp.spec}`);
      continue;
    }
    if (importMap[imp.spec] !== undefined || spec !== imp.spec) {
      src.note(
        "manual",
        imp.start,
        `import-mapped specifier ${imp.spec} -> ${spec}`,
      );
    }
  }
  // dynamic imports of remote modules
  for (const m of src.code.matchAll(/\bimport\s*\(\s*["']/g)) {
    const q = m.index + m[0].length;
    const end = src.text.indexOf(src.text[q - 1], q);
    const spec = src.text.slice(q, end);
    if (/^(jsr:|npm:|https?:)/.test(spec) || importMap[spec]) {
      src.note("manual", m.index, `dynamic import of ${spec}`);
    }
  }
}

function namedList(imp) {
  return imp.named
    .slice(1, -1)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      return m
        ? { type: Boolean(m[1]), name: m[2], local: m[3] ?? m[2] }
        : undefined;
    });
}

function convertAssertImport(src, imp) {
  if (!imp.named || imp.defaultName || imp.namespace) {
    src.note("manual", imp.start, `import form from ${imp.spec}`);
    return;
  }
  const names = namedList(imp);
  if (
    names.some(
      (n) =>
        !n || (!n.type && !(n.name in ASSERTS) && n.name !== "AssertionError"),
    )
  ) {
    const bad = names
      .filter((n) => n && !(n.name in ASSERTS))
      .map((n) => n.name);
    src.note(
      "manual",
      imp.start,
      `assertions without a node:assert mapping: ${bad.join(", ")}`,
    );
    return;
  }
  const calls = [];
  for (const n of names) {
    if (n.type) {
      src.note("manual", imp.start, `type import ${n.name} from ${imp.spec}`);
      return;
    }
    if (n.name === "AssertionError") continue;
    const re = new RegExp(
      `(?<![\\w$.])${escapeRegExp(n.local)}(?![\\w$])`,
      "g",
    );
    for (const m of src.code.matchAll(re)) {
      if (m.index >= imp.start && m.index < imp.end) continue;
      const open = src.code.slice(m.index + m[0].length).match(/^\s*\(/);
      if (!open) {
        src.note("manual", m.index, `${n.local} used other than as a call`);
        return;
      }
      const args = src.args(m.index + m[0].length + open[0].length - 1);
      calls.push({ n, at: m.index, args });
    }
  }
  for (const n of names) src.freed.add(n.local);
  const A = src.needDefault("node:assert/strict", "assert");
  for (const { n, at, args } of calls) {
    const before = src.code.slice(0, at);
    if (
      (n.name === "assertThrows" || n.name === "assertRejects") &&
      !/(^|[;{}\n]|\bawait)\s*$/.test(before)
    ) {
      src.note(
        "manual",
        at,
        `result of ${n.name} is used; Node's ${n.name === "assertThrows" ? "throws" : "rejects"} returns nothing`,
      );
      continue;
    }
    const text = ASSERTS[n.name](A, args.list, src);
    if (text === undefined)
      src.note("manual", at, `${n.name} with these arguments`);
    else src.edit(at, args.close + 1, text);
  }
  const ae = names.find((n) => n.name === "AssertionError");
  if (ae) src.need("node:assert", "AssertionError", ae.local);
  src.edit(imp.start, imp.end + (src.text[imp.end] === "\n" ? 1 : 0), "");
  assertNotes.add(src.path);
}

function convertPathImport(src, imp, sub) {
  const module = /posix/.test(sub ?? "")
    ? "node:path/posix"
    : /windows/.test(sub ?? "")
      ? "node:path/win32"
      : "node:path";
  if (imp.namespace) {
    src.edit(imp.specStart, imp.specEnd, module);
    return;
  }
  if (!imp.named || imp.defaultName) {
    src.note("manual", imp.start, `import form from ${imp.spec}`);
    return;
  }
  const names = namedList(imp);
  if (names.some((n) => !n || !(n.name in PATH_NAMES || n.name in URL_NAMES))) {
    const bad = names
      .filter((n) => n && !(n.name in PATH_NAMES || n.name in URL_NAMES))
      .map((n) => n.name);
    src.note(
      "manual",
      imp.start,
      `@std/path names without a node:path mapping: ${bad.join(", ")}`,
    );
    return;
  }
  const path = [];
  const url = [];
  for (const n of names) {
    const target = PATH_NAMES[n.name] ?? URL_NAMES[n.name];
    const text = `${n.type ? "type " : ""}${target === n.local ? target : `${target} as ${n.local}`}`;
    (n.name in URL_NAMES ? url : path).push(text);
  }
  const lines = [];
  if (path.length)
    lines.push(`import { ${path.join(", ")} } from "${module}";`);
  if (url.length) lines.push(`import { ${url.join(", ")} } from "node:url";`);
  src.edit(imp.start, imp.end, lines.join("\n"));
}

function convertFsImport(src, imp) {
  if (!imp.named || imp.defaultName) {
    src.note("manual", imp.start, `import form from ${imp.spec}`);
    return;
  }
  const names = namedList(imp);
  const supported = new Set([
    "existsSync",
    "exists",
    "ensureDir",
    "ensureDirSync",
  ]);
  const bad = names
    .filter((n) => !n || !supported.has(n.name))
    .map((n) => n?.name);
  if (bad.length) {
    src.note(
      "manual",
      imp.start,
      `@std/fs functions without a mechanical mapping: ${bad.join(", ")}`,
    );
    return;
  }
  for (const n of names) src.freed.add(n.local);
  for (const n of names) {
    const re = new RegExp(
      `(?<![\\w$.])${escapeRegExp(n.local)}(?![\\w$])`,
      "g",
    );
    for (const m of src.code.matchAll(re)) {
      if (m.index >= imp.start && m.index < imp.end) continue;
      const open = src.code.slice(m.index + m[0].length).match(/^\s*\(/);
      if (!open) {
        src.note("manual", m.index, `${n.local} used other than as a call`);
        continue;
      }
      const args = src.args(m.index + m[0].length + open[0].length - 1);
      const a = args.list;
      if (n.name === "existsSync" && a.length === 1) {
        src.edit(m.index, m.index + m[0].length, src.need(FS, "existsSync"));
      } else if (n.name === "exists" && a.length === 1) {
        const access = src.need(FS_PROMISES, "access");
        src.edit(
          m.index,
          args.close + 1,
          P`${access}(${a[0]}).then(() => true, () => false)`,
        );
        src.note(
          "review",
          m.index,
          "exists() now reports false for any access error",
        );
      } else if (n.name === "ensureDir" && a.length === 1) {
        src.edit(
          m.index,
          args.close + 1,
          P`${src.need(FS_PROMISES, "mkdir")}(${a[0]}, { recursive: true })`,
        );
      } else if (n.name === "ensureDirSync" && a.length === 1) {
        src.edit(
          m.index,
          args.close + 1,
          P`${src.need(FS, "mkdirSync")}(${a[0]}, { recursive: true })`,
        );
      } else src.note("manual", m.index, `${n.name} with options`);
    }
  }
  src.edit(imp.start, imp.end + (src.text[imp.end] === "\n" ? 1 : 0), "");
}

// ---------------------------------------------------------------- type-only imports
//
// Node's type stripping keeps every import that is not marked `type`. An
// import of a name that the target module exports only as a type fails at
// run time, so such names get a `type` modifier.

const exportCache = new Map();
function moduleExports(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  let result;
  try {
    const text = readFileSync(file, "utf8");
    const code = mask(text);
    const types = new Set();
    const values = new Set();
    let star = false;
    for (const m of code.matchAll(
      /\bexport\s+(declare\s+)?(interface|type)\s+([\w$]+)/g,
    ))
      types.add(m[3]);
    for (const m of code.matchAll(
      /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(const|let|var|function\*?|class|enum|namespace)\s+([\w$]+)/g,
    ))
      values.add(m[2]);
    for (const m of code.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[2].split(",")) {
        const p = part
          .trim()
          .match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!p) continue;
        (m[1] || p[1] ? types : values).add(p[3] ?? p[2]);
      }
    }
    if (/\bexport\s*\*/.test(code)) star = true;
    result = { types, values, star };
  } catch {
    result = undefined;
  }
  exportCache.set(file, result);
  return result;
}

function markTypeImports(src) {
  if (!src.isTs) return;
  for (const imp of src.importStatements()) {
    if (imp.typeOnly || !imp.named || !/^\.\.?\//.test(imp.spec)) continue;
    if (!TS_EXTENSIONS.has(extname(imp.spec))) continue;
    if (src.overlaps(imp.start, imp.end)) continue;
    const target = moduleExports(join(root, dirname(src.path), imp.spec));
    if (!target) continue;
    const names = namedList(imp);
    if (names.some((n) => !n)) continue;
    const typeOnly = (n) =>
      n.type || (target.types.has(n.name) && !target.values.has(n.name));
    const unknown = names.some(
      (n) => !typeOnly(n) && !target.values.has(n.name) && !target.star,
    );
    if (unknown || !names.some((n) => !n.type && typeOnly(n))) continue;
    const start = imp.start + imp.text.indexOf(imp.named);
    if (!imp.defaultName && names.every(typeOnly)) {
      const parts = names.map((n) =>
        n.name === n.local ? n.name : `${n.name} as ${n.local}`,
      );
      src.edit(
        imp.start,
        start + imp.named.length,
        `import type { ${parts.join(", ")} }`,
      );
    } else {
      const parts = names.map(
        (n) =>
          `${typeOnly(n) ? "type " : ""}${n.name === n.local ? n.name : `${n.name} as ${n.local}`}`,
      );
      src.edit(start, start + imp.named.length, `{ ${parts.join(", ")} }`);
    }
  }
}

// ---------------------------------------------------------------- type stripping
//
// Finds syntax that `node` rejects when it strips types: enums, namespaces
// and modules with runtime code, constructor parameter properties,
// `import x = ...`, `export =`, decorators and JSX. These are reported, never
// rewritten.

let stripTypes;
function nodeStrip(text) {
  if (stripTypes === undefined) {
    stripTypes =
      createRequire(import.meta.url)("node:module").stripTypeScriptTypes ??
      null;
  }
  if (!stripTypes) return undefined;
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    stripTypes(text, { mode: "strip" });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    process.emitWarning = emit;
  }
}

function checkStrippable(src) {
  if (!src.isTs) return;
  const ext = extname(src.path);
  if (ext === ".tsx") {
    src.note("strip", 0, "Node does not strip types from .tsx files");
    return;
  }
  const c = src.code;
  let found = false;
  const report = (pos, message) => {
    found = true;
    src.note("strip", pos, message);
  };
  for (const m of c.matchAll(
    /(?<![\w$.])(declare\s+)?(const\s+)?enum\s+[\w$]+\s*\{/g,
  )) {
    if (!m[1]) report(m.index, "enum");
  }
  for (const m of c.matchAll(
    /(?<![\w$.])(declare\s+)?(export\s+)?(namespace|module)\s+[\w$.]+\s*\{/g,
  )) {
    if (m[1] || /\bdeclare\s+(export\s+)?$/.test(c.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1;
    const body = c.slice(open + 1, src.match(open));
    const runtime = body
      .replace(
        /\b(export\s+)?(interface|type)\s+[\w$]+[^{=]*(\{[^}]*\}|=[^;]*;)/g,
        "",
      )
      .trim();
    if (runtime) report(m.index, `${m[3]} with runtime code`);
  }
  for (const m of c.matchAll(/\bconstructor\s*\(/g)) {
    const args = src.args(m.index + m[0].length - 1);
    if (!args) continue;
    for (const a of args.list) {
      if (
        /^(public|private|protected|readonly|override)\s/.test(
          c.slice(a.start, a.end),
        )
      ) {
        report(a.start, "constructor parameter property");
      }
    }
  }
  for (const m of c.matchAll(
    /(?<![\w$.])import\s+(type\s+)?[\w$]+\s*=(?!=)/g,
  )) {
    if (!m[1]) report(m.index, "import = alias");
  }
  for (const m of c.matchAll(/(?<![\w$.])export\s*=(?!=)/g))
    report(m.index, "export =");
  for (const m of c.matchAll(/(?<![\w$])@[\w$]+/g))
    report(m.index, "decorator");
  if (!found) {
    const error = nodeStrip(src.text);
    if (error)
      note(
        "strip",
        src.path,
        0,
        `Node's type stripping rejects this file: ${error.message}`,
      );
  }
}

// ---------------------------------------------------------------- comments

function checkComments(src) {
  for (const m of src.text.matchAll(
    /\/\/\s*(deno-lint-ignore(?:-file)?|deno-fmt-ignore(?:-file)?|@deno-types|@ts-types)\b[^\n]*/g,
  )) {
    src.note(
      "manual",
      m.index,
      `"${m[1]}" comment has no Biome or Node meaning`,
    );
  }
  for (const m of src.text.matchAll(
    /\/\/\/\s*<reference\s+(lib|types)="(deno[^"]*)"\s*\/>\n?/g,
  )) {
    src.edit(m.index, m.index + m[0].length, "");
  }
  const shebang = src.text.match(/^#!.*\bdeno\b(.*)$/m);
  if (shebang && shebang.index === 0) {
    const tokens = shebang[1].trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === "run") tokens.shift();
    const { flags, notes } = mapRunFlags(
      tokens.filter((t) => t.startsWith("-")),
      {},
    );
    for (const n of notes) src.note(n.level, 0, n.message);
    const line = flags.length
      ? `#!/usr/bin/env -S node ${flags.join(" ")}`
      : "#!/usr/bin/env node";
    src.edit(0, shebang[0].length, line);
  }
}

// ---------------------------------------------------------------- tasks
//
// deno run   -> node [permission flags] script args
// deno test  -> node [permission flags] --test [--test-isolation=none] paths
// deno fmt   -> biome format [--write]
// deno lint  -> biome lint
// deno check -> tsc -p tsconfig.json
// deno task  -> npm run

function shellSplit(text) {
  // Splits a command line into segments separated by && || ; | while keeping
  // quoted strings intact.
  const segments = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (text.startsWith("&&", i) || text.startsWith("||", i)) {
      segments.push(current, text.slice(i, i + 2));
      current = "";
      i++;
    } else if (c === ";" || c === "|") {
      segments.push(current, c);
      current = "";
    } else current += c;
  }
  segments.push(current);
  return segments;
}

function tokens(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

const RUN_DROP =
  /^--(no-check|check|quiet|unstable[\w-]*|no-lock|lock(=.*)?|frozen(=.*)?|node-modules-dir(=.*)?|cached-only|reload(=.*)?|no-prompt|no-remote|no-npm|no-config|vendor(=.*)?)$|^-q$|^-r$/;
const RUN_NOOP =
  /^--(allow-env|allow-net|allow-sys|allow-hrtime|allow-import)(=.*)?$|^-[NES]$/;

function grantPaths(list) {
  const out = [];
  for (const raw of list.split(",").filter(Boolean)) {
    const p = raw.replace(/\/$/, "");
    const abs = resolve(root, p);
    let kind = "missing";
    try {
      kind = statSync(abs).isDirectory() ? "dir" : "file";
    } catch {}
    if (kind !== "missing" && isGitIgnored(p)) kind = "missing";
    if (kind === "missing") out.push(p, `${p}/*`);
    else out.push(p);
  }
  return out;
}

function mapRunFlags(flags, context) {
  const out = [];
  const notes = [];
  let all = false;
  const reads = [];
  const writes = [];
  let config;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "-A" || f === "--allow-all") all = true;
    else if (/^(--allow-read|-R)(=|$)/.test(f))
      reads.push(f.includes("=") ? f.split("=")[1] : "*");
    else if (/^(--allow-write|-W)(=|$)/.test(f))
      writes.push(f.includes("=") ? f.split("=")[1] : "*");
    else if (/^--allow-run(=|$)/.test(f)) out.push("--allow-child-process");
    else if (/^--allow-ffi(=|$)/.test(f)) out.push("--allow-addons");
    else if (RUN_NOOP.test(f)) continue;
    else if (RUN_DROP.test(f)) continue;
    else if (f === "--config" || f === "-c" || f === "--import-map")
      config = flags[++i];
    else if (/^(--config|-c|--import-map)=/.test(f)) config = f.split("=")[1];
    else if (
      /^--(watch|inspect|inspect-brk|inspect-wait)(=.*)?$/.test(f) ||
      /^--env-file(=.*)?$/.test(f)
    )
      out.push(f);
    else if (f === "--env") out.push("--env-file=.env");
    else if (/^--deny-/.test(f))
      notes.push({ level: "manual", message: `${f} has no Node equivalent` });
    else notes.push({ level: "manual", message: `deno flag ${f} dropped` });
  }
  if (
    config &&
    !/^deno(\.[\w-]+)*\.jsonc?$/.test(config.replace(/^\.\//, ""))
  ) {
    notes.push({ level: "manual", message: `--config ${config} dropped` });
  } else if (config && config.replace(/^\.\//, "") !== "deno.json") {
    notes.push({
      level: "manual",
      message: `tasks run with --config ${config}; its import map must be replaced by package.json dependencies`,
      project: true,
    });
  }
  if (all) return { flags: out, notes };
  const permission = ["--permission"];
  const readGrants = [];
  for (const r of reads)
    readGrants.push(...(r === "*" ? ["*"] : grantPaths(r)));
  for (const extra of context.extraReads ?? []) {
    if (!covered(readGrants, extra)) readGrants.push(extra);
  }
  for (const g of minimalGrants(readGrants)) {
    permission.push(`--allow-fs-read=${g}`);
  }
  const writeGrants = writes.flatMap((w) =>
    w === "*" ? ["*"] : grantPaths(w),
  );
  for (const g of minimalGrants(writeGrants)) {
    permission.push(`--allow-fs-write=${g}`);
  }
  return { flags: [...permission, ...out], notes, readGrants };
}

// Drops grants that another grant already covers and puts broader grants
// first. Node 24 loses a directory grant that follows a grant for one of
// its subdirectories (`--allow-fs-read=src --allow-fs-read=.` cannot read
// `.`), so the order matters as well as the length.
function minimalGrants(grants) {
  const unique = [...new Set(grants)];
  const isDir = (g) => {
    try {
      return statSync(resolve(root, g)).isDirectory() && !isGitIgnored(g);
    } catch {
      return false;
    }
  };
  const coversOther = (h, g) => {
    if (h === g) return false;
    if (h === "*") return true;
    if (g === "*") return false;
    const target = resolve(root, g.endsWith("/*") ? `${g.slice(0, -2)}/x` : g);
    if (h.endsWith("/*"))
      return target.startsWith(`${resolve(root, h.slice(0, -2))}/`);
    const base = resolve(root, h);
    return isDir(h) && (target === base || target.startsWith(`${base}/`));
  };
  const kept = unique.filter((g) => !unique.some((h) => coversOther(h, g)));
  const depth = (g) =>
    g === "*"
      ? -1
      : relative(root, resolve(root, g)).split("/").filter(Boolean).length;
  return kept.sort((a, b) => depth(a) - depth(b));
}

function denoReads(flags) {
  const grants = [];
  for (const f of flags) {
    if (/^(--allow-read|-R)$/.test(f) || f === "-A" || f === "--allow-all")
      grants.push("*");
    else if (/^(--allow-read|-R)=/.test(f))
      grants.push(...f.split("=")[1].split(","));
  }
  return grants;
}

function covered(grants, path) {
  const abs = resolve(root, path);
  return grants.some((g) => {
    if (g === "*") return true;
    if (g.endsWith("/*"))
      return abs.startsWith(`${resolve(root, g.slice(0, -2))}/`);
    const base = resolve(root, g);
    return abs === base || abs.startsWith(`${base}/`);
  });
}

// Local files and packages a script loads; Node's permission model needs
// read access to them, which Deno grants implicitly.
function moduleGraph(entries) {
  const files = new Set();
  let packages = false;
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const code = mask(text);
    const specs = [];
    for (const m of code.matchAll(
      /\b(?:import|export)\b[^;'"]*?\bfrom\s*(["'])|\bimport\s*(["'])|\bimport\s*\(\s*(["'])/g,
    )) {
      const q = m.index + m[0].length;
      const end = text.indexOf(text[q - 1], q);
      specs.push(text.slice(q, end));
    }
    for (const spec of specs) {
      if (/^\.\.?\//.test(spec)) {
        const target = relative(root, resolve(root, dirname(file), spec));
        if (
          (!target.startsWith("..") && CODE_EXTENSIONS.has(extname(target))) ||
          extname(target) === ".json"
        )
          queue.push(target);
        else files.add(target);
      } else if (!/^(node:|jsr:|https?:|npm:)/.test(spec)) packages = true;
    }
  }
  return { files: [...files], packages };
}

function testFiles(paths) {
  const all = projectFiles();
  const re = /(^|\/)([^/]*[_.])?test\.(ts|mts|js|mjs|tsx|jsx)$/;
  const out = [];
  for (const p of paths.length ? paths : ["."]) {
    const base = p.replace(/^\.\/?/, "").replace(/\/$/, "");
    for (const f of all) {
      if (base === "" || f === base || f.startsWith(`${base}/`)) {
        if (f === base || re.test(f)) out.push(f);
      }
    }
  }
  return out;
}

function convertSegment(segment, taskName, check) {
  const lead = segment.match(/^\s*/)[0];
  const trail = segment.match(/\s*$/)[0];
  const t = tokens(segment);
  if (t[0] !== "deno") return segment;
  const say = (level, message) =>
    note(level, "deno.json", 0, `task "${taskName}": ${message}`);
  let sub = t[1];
  let rest = t.slice(2);
  if (sub && /\.(ts|mts|js|mjs)$/.test(sub)) {
    rest = [sub, ...rest];
    sub = "run";
  }
  const wrap = (cmd) => `${lead}${cmd}${trail}`;
  if (sub === "task") {
    const [name, ...args] = rest;
    return wrap(`npm run ${name}${args.length ? ` -- ${args.join(" ")}` : ""}`);
  }
  if (sub === "run") {
    const at = rest.findIndex(
      (x, i) =>
        !x.startsWith("-") &&
        !/^(-c|--config|--import-map)$/.test(rest[i - 1] ?? ""),
    );
    if (at < 0) {
      say("manual", "deno run without a script");
      return segment;
    }
    const script = rest[at];
    const graph = moduleGraph([script.replace(/^\.\//, "")]);
    const extraReads = graph.files
      .filter((f) => f !== script.replace(/^\.\//, ""))
      .map((f) => (dirname(f) === "." ? f : dirname(f)));
    if (graph.packages) extraReads.push("node_modules");
    const { flags, notes } = mapRunFlags(rest.slice(0, at), {
      extraReads: [...new Set(extraReads)],
    });
    for (const n of notes) {
      if (n.project) note(n.level, "deno.json", 0, n.message);
      else say(n.level, n.message);
    }
    return wrap(["node", ...flags, ...rest.slice(at)].join(" "));
  }
  if (sub === "test") {
    const flags = [];
    const paths = [];
    const testFlags = [];
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (x === "--config" || x === "-c" || x === "--import-map")
        flags.push(x, rest[++i]);
      else if (x.startsWith("--filter="))
        testFlags.push(`--test-name-pattern=${x.slice(9)}`);
      else if (x === "--filter")
        testFlags.push(`--test-name-pattern=${rest[++i]}`);
      else if (/^--reporter=/.test(x)) {
        const r = { pretty: "spec", dot: "dot", tap: "tap", junit: "junit" }[
          x.slice(11)
        ];
        if (r) testFlags.push(`--test-reporter=${r}`);
        else say("manual", `${x} has no Node reporter`);
      } else if (
        /^--(parallel|trace-leaks|trace-ops|permit-no-files|no-run)$/.test(x)
      )
        continue;
      else if (/^--coverage(=.*)?$/.test(x)) {
        testFlags.push("--experimental-test-coverage");
        say("review", "coverage now uses --experimental-test-coverage");
      } else if (/^--(ignore|doc|fail-fast|shuffle)/.test(x))
        say("manual", `${x} has no node --test equivalent`);
      else if (x.startsWith("-")) flags.push(x);
      else paths.push(x);
    }
    const files = testFiles(paths);
    const graph = moduleGraph(files);
    const extraReads = [
      ".",
      ...graph.files.map((f) => (dirname(f) === "." ? f : dirname(f))),
    ];
    if (graph.packages) extraReads.push("node_modules");
    const { flags: nodeFlags, notes } = mapRunFlags(flags, {
      extraReads: [...new Set(extraReads)],
    });
    for (const n of notes) {
      if (n.project) note(n.level, "deno.json", 0, n.message);
      else say(n.level, n.message);
    }
    const isolated = nodeFlags.includes("--permission")
      ? ["--test-isolation=none"]
      : [];
    if (nodeFlags.includes("--permission") && !covered(denoReads(flags), ".")) {
      say(
        "review",
        "node --test needs read access to the working directory to find test files; added --allow-fs-read=.",
      );
    }
    const nodePaths = (paths.length ? paths : ["."]).map((p) => {
      const clean = p.replace(/^\.\//, "").replace(/\/$/, "");
      let dir = false;
      try {
        dir = statSync(resolve(root, clean || ".")).isDirectory();
      } catch {}
      if (!dir) return clean;
      return `'${clean && clean !== "." ? `${clean}/` : ""}${TEST_GLOB}'`;
    });
    return wrap(
      [
        "node",
        ...nodeFlags,
        "--test",
        ...isolated,
        ...testFlags,
        ...nodePaths,
      ].join(" "),
    );
  }
  if (sub === "fmt") {
    const checkMode = rest.includes("--check");
    const paths = rest.filter((x) => !x.startsWith("-"));
    for (const x of rest.filter((y) => y.startsWith("-") && y !== "--check"))
      say("manual", `deno fmt ${x} dropped`);
    check.biome = true;
    return wrap(
      ["biome", "format", ...(checkMode ? [] : ["--write"]), ...paths].join(
        " ",
      ),
    );
  }
  if (sub === "lint") {
    const fix = rest.includes("--fix");
    const paths = rest.filter((x) => !x.startsWith("-"));
    for (const x of rest.filter((y) => y.startsWith("-") && y !== "--fix"))
      say("manual", `deno lint ${x} dropped`);
    check.biome = true;
    say("review", "Biome's lint rules differ from deno lint's");
    return wrap(
      ["biome", "lint", ...(fix ? ["--write"] : []), ...paths].join(" "),
    );
  }
  if (sub === "check") {
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config" || rest[i] === "-c") {
        i++;
        continue;
      }
      if (!rest[i].startsWith("-")) files.push(rest[i]);
    }
    check.tsc = true;
    check.include.push(...files);
    check.checks++;
    return wrap("tsc -p tsconfig.json");
  }
  say("manual", `"deno ${sub}" has no Node script equivalent`);
  return segment;
}

function convertTasks(tasks) {
  const scripts = {};
  const check = { biome: false, tsc: false, include: [], checks: 0 };
  for (const [name, value] of Object.entries(tasks)) {
    const command = typeof value === "string" ? value : value?.command;
    if (typeof command !== "string") {
      note("manual", "deno.json", 0, `task "${name}" has no command`);
      continue;
    }
    if (typeof value === "object" && value.dependencies) {
      note("manual", "deno.json", 0, `task "${name}" dependencies`);
    }
    scripts[name] = shellSplit(command)
      .map((seg, i) => (i % 2 === 0 ? convertSegment(seg, name, check) : seg))
      .join("");
  }
  if (check.checks > 1) {
    note(
      "review",
      "deno.json",
      0,
      "several deno check tasks now share one tsconfig.json",
    );
  }
  return { scripts, check };
}

// ---------------------------------------------------------------- config files

// JSON as Biome formats it: short arrays of scalars stay on one line.
function formatJson(value, indent = "  ") {
  const walk = (v, depth, width) => {
    const pad = indent.repeat(depth + 1);
    const end = indent.repeat(depth);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const flat = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      if (
        v.every((x) => x === null || typeof x !== "object") &&
        width + flat.length <= 80
      )
        return flat;
      return `[\n${v.map((x) => pad + walk(x, depth + 1, pad.length)).join(",\n")}\n${end}]`;
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v);
      if (entries.length === 0) return "{}";
      return `{\n${entries
        .map(([k, x]) => {
          const key = `${pad}${JSON.stringify(k)}: `;
          return key + walk(x, depth + 1, key.length);
        })
        .join(",\n")}\n${end}}`;
    }
    return JSON.stringify(v);
  };
  return `${walk(value, 0, 0)}\n`;
}

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? m[1] : "  ";
}

function planPackageJson(plan, deno, tasks) {
  const path = "package.json";
  const before = existsSync(join(root, path))
    ? readFileSync(join(root, path), "utf8")
    : undefined;
  const pkg = before ? JSON.parse(before) : {};
  const indent = before ? detectIndent(before) : "  ";
  if (!before) {
    pkg.name = deno?.name ?? basenameOf(root);
    pkg.private = true;
  }
  if (pkg.type === undefined) pkg.type = "module";
  else if (pkg.type !== "module")
    note(
      "manual",
      path,
      0,
      `package.json has "type": "${pkg.type}"; Deno code is ESM`,
    );
  pkg.engines ??= {};
  const current = pkg.engines.node;
  if (!current || engineBelow(current)) pkg.engines.node = NODE_ENGINE;
  if (tasks) {
    pkg.scripts ??= {};
    for (const [name, value] of Object.entries(tasks.scripts)) {
      if (pkg.scripts[name] === undefined || pkg.scripts[name] === value)
        pkg.scripts[name] = value;
      else if (pkg.scripts[name] !== value) {
        note(
          "manual",
          path,
          0,
          `script "${name}" exists and differs from the converted task; left unchanged`,
        );
      }
    }
    pkg.devDependencies ??= {};
    const dev = pkg.devDependencies;
    const want = [];
    if (tasks.check.biome) want.push("@biomejs/biome");
    if (tasks.check.tsc) want.push("typescript", "@types/node");
    for (const name of want) {
      if (!pkg.dependencies?.[name] && !dev[name])
        dev[name] = TOOL_VERSIONS[name];
    }
    if (
      dev["@types/node"] &&
      /^\^?(1\d|20|21)\./.test(dev["@types/node"].replace(/^[\^~]/, ""))
    ) {
      dev["@types/node"] = TOOL_VERSIONS["@types/node"];
    }
    if (Object.keys(dev).length) pkg.devDependencies = sortKeys(dev);
    else delete pkg.devDependencies;
  }
  if (npmDependencies.size) {
    pkg.dependencies ??= {};
    const deps = pkg.dependencies;
    for (const [name, version] of npmDependencies) deps[name] ??= version;
    pkg.dependencies = sortKeys(deps);
  }
  const after = formatJson(pkg, indent);
  if (after !== before) plan.files.set(path, { before, after });
  if (
    after !== before &&
    (tasks?.check.biome || tasks?.check.tsc || npmDependencies.size)
  ) {
    plan.afterword.add("run npm install to install the new devDependencies");
  }
}

function basenameOf(dir) {
  return dir.split("/").filter(Boolean).pop();
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function engineBelow(range) {
  const m = range.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major < 22 || (major === 22 && minor < 18);
}

function planTsconfig(plan, deno, check) {
  if (!check?.tsc) return;
  const path = "tsconfig.json";
  if (existsSync(join(root, path))) {
    note(
      "review",
      path,
      0,
      "tsconfig.json exists; check it has noEmit, allowImportingTsExtensions, erasableSyntaxOnly and verbatimModuleSyntax",
    );
    return;
  }
  const compilerOptions = {
    target: "ESNext",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ESNext"],
    types: ["node"],
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    resolveJsonModule: true,
    skipLibCheck: true,
  };
  for (const [key, value] of Object.entries(deno?.compilerOptions ?? {})) {
    if (key === "lib") {
      const lib = value.filter((l) => !/^deno\./.test(l));
      if (lib.length) compilerOptions.lib = lib;
      if (value.some((l) => /^dom/.test(l)))
        note(
          "review",
          path,
          0,
          `compilerOptions.lib ${JSON.stringify(value)}: Node has no DOM`,
        );
    } else if (key === "types")
      note("manual", path, 0, `compilerOptions.types ${JSON.stringify(value)}`);
    else if (key === "jsx" || key.startsWith("jsx"))
      note("manual", path, 0, `compilerOptions.${key}`);
    else compilerOptions[key] = value;
  }
  const include = [...new Set(check.include)];
  const config = { compilerOptions, include };
  if (deno?.exclude) config.exclude = deno.exclude;
  plan.files.set(path, { before: undefined, after: formatJson(config) });
}

function planBiome(plan, deno, check) {
  if (!check?.biome) return;
  const path = "biome.json";
  if (existsSync(join(root, path)) || existsSync(join(root, "biome.jsonc"))) {
    note(
      "review",
      path,
      0,
      "biome.json exists; formatter options were not merged",
    );
    return;
  }
  const fmt = deno?.fmt ?? {};
  const o = fmt.options ?? fmt;
  const excludes = [
    ...(deno?.exclude ?? []),
    ...(fmt.exclude ?? []),
    ...(deno?.lint?.exclude ?? []),
  ];
  const includes = [
    "**",
    ...[...new Set(excludes)].map(
      (e) => `!${e.replace(/\/\*\*$/, "").replace(/\/$/, "")}`,
    ),
  ];
  const config = {
    $schema: `https://biomejs.dev/schemas/${TOOL_VERSIONS["@biomejs/biome"].replace(/^\^/, "")}/schema.json`,
    vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
    files: { includes },
    formatter: {
      indentStyle: o.useTabs ? "tab" : "space",
      indentWidth: o.indentWidth ?? 2,
      lineWidth: o.lineWidth ?? 80,
    },
    javascript: {
      formatter: {
        quoteStyle: o.singleQuote ? "single" : "double",
        quoteProperties: "preserve",
        semicolons: o.semiColons === false ? "asNeeded" : "always",
        trailingCommas: "all",
      },
    },
    // deno lint does not enforce non-null assertions by default
    linter: {
      rules: { preset: "recommended", style: { noNonNullAssertion: "off" } },
    },
  };
  if (fmt.include || deno?.lint?.include)
    note(
      "review",
      path,
      0,
      "deno fmt/lint include lists were not carried over",
    );
  if (deno?.lint?.rules)
    note(
      "manual",
      path,
      0,
      "deno lint rule configuration was not carried over",
    );
  note(
    "review",
    path,
    0,
    "Biome formats some constructs differently from deno fmt; run biome format and review the diff",
  );
  plan.files.set(path, { before: undefined, after: formatJson(config) });
}

function convertWorkflow(path, plan) {
  const before = readFileSync(join(root, path), "utf8");
  let after = before.replace(
    /^([ \t]*)- uses: denoland\/setup-deno@[^\n]*\n(?:\1 {2}[^\n]*\n)*/gm,
    "",
  );
  after = after.replace(/\bdeno task (\S+)/g, "npm run $1");
  after = after.replace(
    /(node-version:\s*)["']?(\d+)(?:\.x)?["']?/g,
    (m, p, v) => (Number(v) < 24 ? `${p}24` : m),
  );
  const lines = after.split("\n");
  lines.forEach((l, i) => {
    if (/\bdeno\b/i.test(l))
      note("manual", path, i + 1, `CI still mentions Deno: ${l.trim()}`);
  });
  if (/actions\/setup-node/.test(after) && !/npm (ci|install)/.test(after)) {
    note("review", path, 0, "workflow sets up Node but never runs npm ci");
  }
  if (!/actions\/setup-node/.test(after))
    note("manual", path, 0, "workflow has no actions/setup-node step");
  if (after !== before) plan.files.set(path, { before, after });
}

// ---------------------------------------------------------------- diff

function diffLines(a, b) {
  // Myers diff over lines, printed as unified hunks with three lines of context.
  const x = a === "" ? [] : a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]);
      let i = down ? v[max + k + 1] : v[max + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[max + k] = i;
      if (i >= n && j >= m) break search;
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const t = trace[d];
    const k = i - j;
    const down = k === -d || (k !== d && t[max + k - 1] < t[max + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const pi = t[max + pk];
    const pj = pi - pk;
    while (i > pi && j > pj) {
      i--;
      j--;
      ops.push([" ", x[i]]);
    }
    if (i === pi) {
      j--;
      ops.push(["+", y[j]]);
    } else {
      i--;
      ops.push(["-", x[i]]);
    }
  }
  while (i > 0) {
    i--;
    ops.push([" ", x[i]]);
  }
  ops.reverse();
  // line numbers before each op
  const at = [];
  let ai = 1;
  let bi = 1;
  for (const [op] of ops) {
    at.push([ai, bi]);
    if (op !== "+") ai++;
    if (op !== "-") bi++;
  }
  const changed = ops
    .map((o, k) => (o[0] === " " ? -1 : k))
    .filter((k) => k >= 0);
  const out = [];
  let h = 0;
  while (h < changed.length) {
    let last = h;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 7)
      last++;
    const from = Math.max(0, changed[h] - 3);
    const to = Math.min(ops.length, changed[last] + 4);
    const hunk = ops.slice(from, to);
    const aLen = hunk.filter((o) => o[0] !== "+").length;
    const bLen = hunk.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${at[from][0]},${aLen} +${at[from][1]},${bLen} @@`);
    for (const [op, line] of hunk) out.push(`${op}${line}`);
    h = last + 1;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- main

const npmDependencies = new Map();
const assertNotes = new Set();

function main() {
  const plan = { files: new Map(), remove: [], afterword: new Set() };
  const files = projectFiles();
  const denoFiles = files.filter(
    (f) => !f.includes("/") && DENO_CONFIG.test(f),
  );
  const denoJsonPath = ["deno.json", "deno.jsonc"].find((f) =>
    files.includes(f),
  );
  const deno = denoJsonPath
    ? readJsonc(readFileSync(join(root, denoJsonPath), "utf8"))
    : undefined;
  const importMap = { ...(deno?.imports ?? {}) };
  if (deno?.importMap)
    note("manual", denoJsonPath, 0, `importMap ${deno.importMap}`);
  for (const f of denoFiles.filter(
    (f) => f !== denoJsonPath && f.endsWith(".json"),
  )) {
    try {
      const extra = readJsonc(readFileSync(join(root, f), "utf8"));
      if (extra.imports) {
        for (const [k, v] of Object.entries(extra.imports)) {
          note(
            "manual",
            f,
            0,
            `import map entry "${k}" -> ${v}: use a package.json dependency or imports field`,
          );
        }
      }
    } catch {}
  }
  for (const [k, v] of Object.entries(importMap)) {
    if (!STD.test(v) && !v.startsWith("npm:")) {
      note(
        "manual",
        denoJsonPath,
        0,
        `import map entry "${k}" -> ${v}: use a package.json dependency or imports field`,
      );
    }
  }
  for (const key of [
    "workspace",
    "exports",
    "publish",
    "test",
    "bench",
    "unstable",
    "nodeModulesDir",
    "vendor",
    "lock",
  ]) {
    if (
      deno?.[key] !== undefined &&
      !["nodeModulesDir", "lock", "vendor"].includes(key)
    ) {
      note("manual", denoJsonPath, 0, `deno.json "${key}" has no conversion`);
    }
  }

  const self = resolve(import.meta.filename);
  for (const path of files) {
    const ext = extname(path);
    if (path.startsWith("node_modules/") || join(root, path) === self) continue;
    if (CODE_EXTENSIONS.has(ext)) {
      const text = readFileSync(join(root, path), "utf8");
      const src = new Source(path, text);
      convertDeno(src);
      convertImports(src, importMap);
      markTypeImports(src);
      checkComments(src);
      checkStrippable(src);
      const after = src.result();
      if (after !== text) plan.files.set(path, { before: text, after });
    } else if (ext === ".md") {
      const text = readFileSync(join(root, path), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\bdeno\b/i.test(line))
          note("docs", path, i + 1, line.trim().slice(0, 120));
      });
    } else if (/^\.github\/workflows\/.*\.ya?ml$/.test(path)) {
      convertWorkflow(path, plan);
    } else if (path === ".vscode/settings.json") {
      const text = readFileSync(join(root, path), "utf8");
      if (/"deno\./.test(text))
        note("manual", path, 0, "editor settings enable the Deno extension");
    }
  }
  if (assertNotes.size) {
    note(
      "review",
      "(project)",
      0,
      `${assertNotes.size} file(s) moved from @std/assert to node:assert/strict; deepStrictEqual compares prototypes where assertEquals does not always`,
    );
  }

  const tasks = deno?.tasks ? convertTasks(deno.tasks) : undefined;
  if (deno || plan.files.size) planPackageJson(plan, deno, tasks);
  planTsconfig(plan, deno, tasks?.check);
  planBiome(plan, deno, tasks?.check);
  if (options.removeDenoConfig) plan.remove.push(...denoFiles);
  else if (denoFiles.length)
    plan.afterword.add(
      `once Node passes, rerun with --write --remove-deno-config to delete ${denoFiles.join(", ")}`,
    );
  return plan;
}

const plan = main();

if (options.write) {
  for (const [path, { after }] of plan.files)
    writeFileSync(join(root, path), after);
  for (const path of plan.remove) rmSync(join(root, path));
}

const counts = {};
for (const f of findings) counts[f.level] = (counts[f.level] ?? 0) + 1;

if (options.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        root,
        write: options.write,
        changed: [...plan.files.keys()],
        removed: plan.remove,
        findings,
        counts,
        next: [...plan.afterword],
      },
      null,
      2,
    )}\n`,
  );
} else {
  const out = [];
  if (options.diff) {
    for (const [path, { before, after }] of plan.files) {
      out.push(
        `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
        `+++ b/${path}`,
      );
      out.push(diffLines(before ?? "", after));
    }
    for (const path of plan.remove)
      out.push(`--- a/${path}`, "+++ /dev/null", "@@ removed @@");
    if (out.length) out.push("");
  }
  out.push(
    `${options.write ? "Changed" : "Would change"} ${plan.files.size} file(s)${plan.remove.length ? `, ${options.write ? "removed" : "would remove"} ${plan.remove.length}` : ""}.`,
  );
  for (const level of Object.keys(LEVELS)) {
    const list = findings.filter((f) => f.level === level);
    if (!list.length) continue;
    out.push("", `${level} (${list.length}): ${LEVELS[level]}`);
    for (const f of list.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    )) {
      out.push(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
    }
  }
  if (plan.afterword.size) {
    out.push("", "Next:");
    for (const a of plan.afterword) out.push(`  ${a}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
}
process.exitCode = 0;
