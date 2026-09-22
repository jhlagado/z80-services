# Project instructions

Z80 Services owns provider-neutral contracts used by running Z80 programs.
Keep compiler, assembler, linker, NOBJ and build-host operations in Z80 Tool
Services. Keep language lowering and runtime representation in the consuming
language, and keep hardware or operating-system providers with their platform.

Use ATOM syntax for all Z80 assembly. Treat contract JSON as the numeric
authority and generate matching TypeScript and ATOM constants. Any contract
change must update prose, generated projections and conformance evidence in
one commit.

The synchronous bounded profile is the base. Do not make scheduling, callbacks
or interrupts a requirement without measured target evidence.
