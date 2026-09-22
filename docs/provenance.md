# Provenance

The P2 transport and scheduler were developed in the private Skate repository
before the shared program-service boundary was identified. Their source and
tests were extracted without semantic changes from these Skate commits:

- `8058c06` — define the synchronous terminal effect protocol;
- `2b7204e` — add cooperative effect scheduling;
- `5d07526` — requalify the P1–P7 runtime and macro semantics.

The extracted files are:

- `docs/p2-transport.md`;
- `reference/p2-transport.ts` and its tests;
- `reference/p2-scheduler.ts` and its tests.

Future work should migrate program-facing byte-stream semantics from Z80 Tool
Services through an explicit compatibility release. The unfinished NOBJ work
in that repository is build tooling and is not part of this extraction.
