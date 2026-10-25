# Deno to Node conversion

`deno-to-node.mjs` converts a Deno project to Node 24 mechanically. It has no
dependencies, so it runs from this checkout against any other repository:

```sh
node ~/projects/z80-services/tools/deno-to-node.mjs ~/projects/skate
```

The default is a dry run. It prints the planned changes as unified diffs, then
a report of everything it did not convert or that needs checking, with file and
line. Nothing is written.

| Option | Effect |
| --- | --- |
| `--write` | apply the changes |
| `--remove-deno-config` | with `--write`, delete `deno.json`, `deno.jsonc`, `deno.lock` and other top-level `deno.*.json` files |
| `--no-diff` | print only the report |
| `--json` | print the report as JSON |

The conversion is idempotent: a second run over a converted project changes
nothing. Existing `package.json` scripts are never overwritten; a task whose
converted command differs from an existing script is reported instead.

## Procedure

1. Run the dry run and read the report.
2. Record the outputs the Deno build generates, so they can be compared later.
3. Run with `--write`, then `npm install`.
4. Fix what the report lists under `strip` and `manual`, and check the items
   under `review`.
5. Run every converted script and compare the generated outputs with the
   recorded ones.
6. Run with `--write --remove-deno-config`, update the documentation the
   report lists under `docs`, and commit.

`z80-services` was converted this way; its generated contract, ATOM include and
release archive are byte-identical under both runtimes.

## Report levels

| Level | Meaning |
| --- | --- |
| `strip` | TypeScript that Node's type stripping rejects: enums, namespaces with runtime code, constructor parameter properties, `import x = ...`, `export =`, decorators and `.tsx`. Never rewritten. |
| `manual` | A construct with no mechanical equivalent, left as it is. |
| `review` | Converted, but the behaviour can differ; check it. |
| `docs` | A Markdown line that mentions Deno. Prose is never rewritten. |

## Code

| Deno | Node |
| --- | --- |
| `Deno.test(name, fn)`, `Deno.test(fn)` | `test(...)` from `node:test` |
| `Deno.test({ name, fn, ignore, only })` and `(name, options, fn)` | `test(name, { skip, only }, fn)`; sanitizer options are dropped, `permissions` is reported |
| `Deno.test.ignore`, `Deno.test.only` | `test.skip`, `test.only` (reported: Node needs `--test-only`) |
| `t.step(name, fn)` | `t.test(name, fn)` |
| `Deno.TestContext` | `TestContext` from `node:test` |
| `Deno.readTextFile(p)`, `...Sync` | `readFile(p, "utf8")`, `readFileSync(p, "utf8")` |
| `Deno.readFile(p)`, `...Sync` | `new Uint8Array(await readFile(p))` |
| `Deno.writeTextFile`, `Deno.writeFile`, `...Sync` | `writeFile`, `writeFileSync`; `{ append: true }` becomes `appendFile` |
| `Deno.mkdir`, `copyFile`, `rename`, `readLink`, `realPath`, `chmod`, `truncate`, `utime`, `link`, `symlink` and their `Sync` forms | the `node:fs` and `node:fs/promises` equivalents |
| `Deno.remove(p, { recursive: true })` | `rm(p, { recursive: true })`; without `recursive` it is reported, because `rm` does not remove empty directories |
| `Deno.stat`, `lstat` and `Sync` forms | `stat` and friends; `.isFile`, `.isDirectory` and `.isSymlink` reads on the result become `isFile()`, `isDirectory()` and `isSymbolicLink()` |
| `for await (const e of Deno.readDir(d))` | `for (const e of await readdir(d, { withFileTypes: true }))`, with the same property rewrite on `e` inside the loop |
| `x instanceof Deno.errors.NotFound` | `x?.code === "ENOENT"` (also `AlreadyExists`, `PermissionDenied`, `IsADirectory`, `NotADirectory`, `NotEmpty`) |
| `Deno.args`, `Deno.exit`, `Deno.cwd`, `Deno.chdir`, `Deno.pid` | `process.argv.slice(2)`, `process.exit`, `process.cwd`, `process.chdir`, `process.pid` |
| `Deno.env.get/set/has/delete/toObject` | `process.env` |
| `Deno.execPath()` | `process.execPath` (reported: it now names `node`) |
| `Deno.inspect`, `Deno.hostname` | `node:util` `inspect`, `node:os` `hostname` |
| `Deno.Command`, `Deno.open`, `Deno.version`, `Deno.build` and the rest | reported |

`Deno.readFile` results are copied into a plain `Uint8Array` because Node
returns a `Buffer`. A `Buffer` compares unequal to a `Uint8Array` under
`assert.deepStrictEqual`, prints differently and shares memory when sliced.

Imports that name a type exported only as a type gain a `type` modifier,
because type stripping keeps every import that is not marked.

## Standard library

`@std/assert` becomes `node:assert/strict`. That keeps converted projects free
of registry dependencies and matches the tests already written against
`node:assert`. The usual assertions map one to one (`assertEquals` to
`deepStrictEqual`, `assertThrows(fn, Class, text)` to a validation function,
and so on); unmapped assertions are reported and their import is left alone.
`assertEquals` and `deepStrictEqual` differ in edge cases, such as prototypes,
so the report lists the files that changed.

`@std/path` becomes `node:path`, with `fromFileUrl` and `toFileUrl` imported
from `node:url` under their old names. `@std/fs` `existsSync`, `exists`,
`ensureDir` and `ensureDirSync` are converted; `walk`, `copy`, `expandGlob` and
the rest are reported. Other `jsr:` and `https:` imports are reported; `npm:`
specifiers become bare imports plus `package.json` dependencies.

## Tasks

Each `deno.json` task becomes a `package.json` script of the same name.

| Deno | Node |
| --- | --- |
| `deno task x` | `npm run x` |
| `deno run flags script args` | `node permission-flags script args` |
| `deno test flags paths` | `node permission-flags --test --test-isolation=none 'path/**/{*_,*.,}test.{ts,mts,js,mjs}'` |
| `deno fmt`, `deno fmt --check` | `biome format --write`, `biome format` |
| `deno lint` | `biome lint` |
| `deno check files` | `tsc -p tsconfig.json`, with the files in `include` |

Permissions map onto Node's permission model:

- `-A` drops all permission flags.
- `--allow-read=a,b` becomes `--permission --allow-fs-read=a --allow-fs-read=b`;
  writes map the same way.
- `--allow-run` becomes `--allow-child-process`.
- `--allow-env`, `--allow-net` and `--allow-sys` have no Node 24 counterpart and
  are dropped.

Node needs read access to every module it loads, where Deno grants that
implicitly, so the converter follows the script's static imports and adds the
directories they live in, plus `node_modules` when a package is imported.

Node treats a grant for a path that does not exist as a file grant. A missing or
git-ignored path, such as `dist`, therefore becomes both `dist` and `dist/*`, so
the script can create the directory and write inside it on a fresh checkout.
Grants already covered by a broader one are dropped and the rest are ordered
broadest first. Node 24 loses a directory grant that follows a grant for one of
its subdirectories, so `--allow-fs-read=src --allow-fs-read=.` cannot read `.`.

`node --test` spawns a process per file, which the permission model blocks, so
permission-checked test scripts run with `--test-isolation=none`. Like Deno,
this runs every test file in one process. The runner also has to read the
working directory to find test files, so `.` is added to the read grants and
reported.

## Configuration

`package.json` gains `"type": "module"`, `engines.node` of `>=22.18` (the first
release with type stripping on by default), the scripts, and Biome, TypeScript
and `@types/node` as devDependencies when the tasks need them.

The generated `tsconfig.json` sets `noEmit`, `allowImportingTsExtensions`,
`erasableSyntaxOnly` and `verbatimModuleSyntax`, so `tsc` rejects what Node
cannot strip. Deno `compilerOptions` are carried over except the `deno.*`
libraries.

The generated `biome.json` follows the `deno fmt` options: two-space indent,
80 columns, double quotes, semicolons, and quoted property names left as
written. Biome still lays out some expressions differently from `deno fmt`, so
the first `biome format --write` touches most files. Biome's recommended lint
rules are used without `noNonNullAssertion`, which `deno lint` does not
enforce by default.

GitHub workflows lose the `setup-deno` step, `deno task` becomes `npm run`, and
`node-version` below 24 becomes 24.
