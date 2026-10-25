import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const tool = new URL("./deno-to-node.mjs", import.meta.url).pathname;

// A small Deno project that uses the constructs the converter rewrites.
const fixture = {
  "deno.json": JSON.stringify(
    {
      tasks: {
        test: "deno test --allow-read=src src/",
        run: "deno run --allow-read=src/data --allow-env src/main.ts --flag",
        all: "deno task test && deno run -A src/main.ts",
      },
      imports: { "@std/assert": "jsr:@std/assert@^1" },
    },
    null,
    2,
  ),
  ".github/workflows/ci.yml": [
    "jobs:",
    "  verify:",
    "    steps:",
    "      - uses: denoland/setup-deno@v2",
    "        with:",
    "          deno-version: v2.x",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20",
    "      - run: npm ci",
    "      - run: deno task test",
    "",
  ].join("\n"),
  "src/data/a.txt": "hello\n",
  "src/data/sub/.keep": "",
  "src/types.ts": [
    "export interface Shape { size: number }",
    "export const VERSION = 1;",
    "",
  ].join("\n"),
  "src/main.ts": [
    'import { join, fromFileUrl } from "jsr:@std/path@^1";',
    'import { existsSync } from "jsr:@std/fs@^1";',
    'import { Shape, VERSION } from "./types.ts";',
    "",
    "export async function listFiles(dir: string): Promise<string[]> {",
    "  const out: string[] = [];",
    "  for await (const entry of Deno.readDir(dir)) {",
    "    if (entry.isFile) out.push(entry.name);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source
    "    else if (entry.isDirectory) out.push(`${entry.name}/`);",
    "  }",
    "  return out.sort();",
    "}",
    "",
    "export async function size(path: string): Promise<number | undefined> {",
    "  try {",
    "    const info = await Deno.stat(path);",
    "    return info.isFile ? info.size : undefined;",
    "  } catch (error) {",
    "    if (error instanceof Deno.errors.NotFound) return undefined;",
    "    throw error;",
    "  }",
    "}",
    "",
    "export function shape(): Shape {",
    "  return { size: VERSION };",
    "}",
    "",
    "if (import.meta.main) {",
    '  const here = fromFileUrl(new URL(".", import.meta.url));',
    '  console.log(JSON.stringify([Deno.args, Deno.env.get("HOME") !== undefined, existsSync(join(here, "data"))]));',
    '  console.log(JSON.stringify(await listFiles(join(here, "data"))));',
    '  console.log(await Deno.readTextFile(join(here, "data/a.txt")));',
    "  Deno.exit(0);",
    "}",
    "",
  ].join("\n"),
  "src/main_test.ts": [
    'import { assertEquals, assert, assertThrows } from "@std/assert";',
    'import { listFiles, size } from "./main.ts";',
    "",
    'Deno.test("lists", async () => {',
    '  assertEquals(await listFiles("src/data"), ["a.txt", "sub/"]);',
    "});",
    "",
    "Deno.test({",
    '  name: "sizes",',
    "  ignore: false,",
    "  sanitizeOps: false,",
    "  async fn(t: Deno.TestContext) {",
    '    await t.step("present", async () => {',
    '      assertEquals(await size("src/data/a.txt"), 6);',
    "    });",
    '    await t.step("missing", async () => {',
    '      assert((await size("src/none")) === undefined);',
    "    });",
    "  },",
    "});",
    "",
    'Deno.test("throws", () => {',
    '  assertThrows(() => { throw new TypeError("bad thing"); }, TypeError, "bad");',
    "});",
    "",
    'Deno.test("bytes", async () => {',
    '  const bytes = await Deno.readFile("src/data/a.txt");',
    '  assertEquals(bytes, new TextEncoder().encode("hello\\n"));',
    "});",
    "",
    'Deno.test.ignore("skipped", () => {});',
    "",
  ].join("\n"),
  "src/legacy.ts": [
    "export enum Color { Red, Green }",
    "namespace Util { export const x = 1; }",
    "export class Box { constructor(private readonly size: number) {} }",
    'import fs = require("node:fs");',
    "",
  ].join("\n"),
  "src/spawn.ts":
    'await new Deno.Command("git", { args: ["status"] }).output();\n',
  "README.md": "Run `deno task test`.\n",
};

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "deno-to-node-"));
  for (const [path, text] of Object.entries(fixture)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function convert(root, ...args) {
  return execFileSync(process.execPath, [tool, "--json", ...args, root], {
    encoding: "utf8",
  });
}

test("converts a Deno project that then runs under Node", () => {
  const root = makeProject();
  try {
    const report = JSON.parse(convert(root, "--write"));
    const read = (path) => readFileSync(join(root, path), "utf8");

    const main = read("src/main.ts");
    assert.match(
      main,
      /for \(const entry of await readdir\(dir, \{ withFileTypes: true \}\)\)/,
    );
    assert.match(main, /entry\.isFile\(\)/);
    assert.match(main, /info\.isFile\(\) \? info\.size/);
    assert.match(
      main,
      /\(error as NodeJS\.ErrnoException \| null\)\?\.code === "ENOENT"/,
    );
    assert.match(
      main,
      /import \{ type Shape, VERSION \} from "\.\/types\.ts";/,
    );
    assert.match(
      main,
      /import \{ fileURLToPath as fromFileUrl \} from "node:url";/,
    );
    assert.doesNotMatch(main, /Deno\./);

    const tests = read("src/main_test.ts");
    assert.match(
      tests,
      /test\("sizes", \{ skip: false \}, async function \(t: TestContext\)/,
    );
    assert.match(tests, /await t\.test\("present"/);
    assert.match(
      tests,
      /new Uint8Array\(await readFile\("src\/data\/a\.txt"\)\)/,
    );
    assert.match(tests, /test\.skip\("skipped"/);
    assert.doesNotMatch(tests, /Deno\.|@std\//);

    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.engines.node, ">=22.18");
    assert.equal(
      pkg.scripts.test,
      "node --permission --allow-fs-read=. --test --test-isolation=none 'src/**/{*_,*.,}test.{ts,mts,js,mjs}'",
    );
    assert.equal(
      pkg.scripts.run,
      "node --permission --allow-fs-read=src src/main.ts --flag",
    );
    assert.equal(pkg.scripts.all, "npm run test && node src/main.ts");

    const ci = read(".github/workflows/ci.yml");
    assert.doesNotMatch(ci, /deno/);
    assert.match(ci, /node-version: 24/);
    assert.match(ci, /npm run test/);

    const strip = report.findings.filter((f) => f.level === "strip");
    assert.deepEqual(
      strip.map((f) => `${f.file}:${f.line} ${f.message}`),
      [
        "src/legacy.ts:1 enum",
        "src/legacy.ts:2 namespace with runtime code",
        "src/legacy.ts:3 constructor parameter property",
        "src/legacy.ts:4 import = alias",
      ],
    );
    assert.ok(
      report.findings.some(
        (f) =>
          f.level === "manual" &&
          f.file === "src/spawn.ts" &&
          f.line === 1 &&
          /Deno\.Command/.test(f.message),
      ),
    );
    assert.ok(
      report.findings.some((f) => f.level === "docs" && f.file === "README.md"),
    );

    // the converted tests pass under Node
    execFileSync(process.execPath, ["--test", "src/main_test.ts"], {
      cwd: root,
      stdio: "pipe",
    });
    const out = execFileSync(process.execPath, ["src/main.ts", "--flag"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(out, '[["--flag"],true,true]\n["a.txt","sub/"]\nhello\n\n');

    // a second run changes nothing
    const again = JSON.parse(convert(root, "--write"));
    assert.deepEqual(again.changed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run writes nothing; --remove-deno-config deletes deno.json", () => {
  const root = makeProject();
  try {
    const before = readFileSync(join(root, "src/main.ts"), "utf8");
    const dry = JSON.parse(convert(root));
    assert.ok(dry.changed.includes("src/main.ts"));
    assert.equal(readFileSync(join(root, "src/main.ts"), "utf8"), before);
    const removed = JSON.parse(
      convert(root, "--write", "--remove-deno-config"),
    );
    assert.deepEqual(removed.removed, ["deno.json"]);
    assert.throws(() => readFileSync(join(root, "deno.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
