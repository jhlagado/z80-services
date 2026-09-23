# Releasing

`deno task release` writes a deterministic uncompressed tar bundle to `dist/`
and updates the tracked manifest and checksum under `release/`. The archive has
fixed metadata, sorted entries and an internal `MANIFEST.json`, so rebuilding
the same sources produces the same SHA-256.

Before tagging:

1. install the locked host dependencies with `npm ci`;
2. run `deno task verify`;
3. run `deno task release` and inspect the manifest;
4. run `deno task verify` again;
5. confirm a clean tree and tag the verified commit.

Attach the tar, external checksum and manifest to the GitHub release. Consumers
can verify both the archive and every selected file without trusting npm or a
moving branch.
