const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await Deno.readTextFile(new URL("package.json", root)),
) as { version: string };
const version = packageJson.version;
const archiveName = `z80-services-${version}.tar`;
const manifestPath = `release/z80-services-${version}.manifest.json`;
const checksumPath = `release/z80-services-${version}.sha256`;

const releaseFiles = [
  "LICENSE",
  "README.md",
  "contracts/z80-services-v0.json",
  "conformance/vectors/byte-gateway-v0.json",
  "docs/architecture.md",
  "docs/byte-gateway-v0.md",
  "docs/consumer-audit.md",
  "docs/dependencies.md",
  "native/README.md",
  "native/client/byte-gateway.asm",
  "native/include/z80-services-v0.asmi",
  "native/providers/io-port-byte-gateway.asm",
  "native/providers/memory-byte-gateway.asm",
  "proofs/byte-gateway-v0.json",
  "reference/byte-gateway.ts",
  "reference/contract.ts",
  "reference/io-port-gateway.ts",
].sort();

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes);
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
  );
};

function putText(
  block: Uint8Array,
  offset: number,
  length: number,
  text: string,
) {
  const bytes = encoder.encode(text);
  if (bytes.length > length) throw new Error(`tar field is too long: ${text}`);
  block.set(bytes, offset);
}

function putOctal(
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
) {
  putText(block, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function tarEntry(path: string, contents: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  putText(header, 0, 100, path);
  putOctal(header, 100, 8, 0o644);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, contents.length);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  putText(header, 257, 6, "ustar");
  putText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(contents.length / 512) * 512;
  const entry = new Uint8Array(512 + padded);
  entry.set(header);
  entry.set(contents, 512);
  return entry;
}

const sourceEntries = await Promise.all(
  releaseFiles.map(async (path) => {
    const contents = await Deno.readFile(new URL(path, root));
    return {
      path,
      contents,
      size: contents.length,
      sha256: await sha256(contents),
    };
  }),
);
const manifest = `${
  JSON.stringify(
    {
      name: "z80-services",
      version,
      profile: { name: "byteGateway", version: 0 },
      files: sourceEntries.map(({ path, size, sha256 }) => ({
        path,
        size,
        sha256,
      })),
    },
    null,
    2,
  )
}\n`;
const manifestBytes = encoder.encode(manifest);
const tarParts = [
  ...sourceEntries.map(({ path, contents }) => tarEntry(path, contents)),
  tarEntry("MANIFEST.json", manifestBytes),
  new Uint8Array(1024),
];
const tarLength = tarParts.reduce((sum, part) => sum + part.length, 0);
const tar = new Uint8Array(tarLength);
let cursor = 0;
for (const part of tarParts) {
  tar.set(part, cursor);
  cursor += part.length;
}
const checksum = `${await sha256(tar)}  ${archiveName}\n`;

if (Deno.args.includes("--check")) {
  const expectedManifest = await Deno.readTextFile(new URL(manifestPath, root));
  const expectedChecksum = await Deno.readTextFile(new URL(checksumPath, root));
  if (expectedManifest !== manifest || expectedChecksum !== checksum) {
    throw new Error("release manifest or archive checksum is stale");
  }
} else {
  await Deno.mkdir(new URL("release/", root), { recursive: true });
  await Deno.mkdir(new URL("dist/", root), { recursive: true });
  await Deno.writeTextFile(new URL(manifestPath, root), manifest);
  await Deno.writeTextFile(new URL(checksumPath, root), checksum);
  await Deno.writeFile(new URL(`dist/${archiveName}`, root), tar);
}
