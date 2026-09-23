# Z80 Services

Z80 Services defines portable services used by running Z80 programs. It gives
programs a stable way to use byte streams, storage, terminals, input events and
other external facilities without making CP/M, Triptych or a particular device
part of a language runtime.

The project owns the shared service contracts, conformance vectors, portable
ATOM client modules and host reference implementations. Language-facing
adapters remain with their languages: Skate exposes Scheme ports, Nucleus
exposes its own procedures, and Atom programs use assembly bindings.

Platform providers also remain with their platforms. CP/M may implement a
service through BDOS, while Triptych, MSX-DOS, TRSDOS, a browser or bare
hardware may implement the same contract differently.

## Boundary

This repository is for operations performed by a running program.
[Z80 Tool Services](https://github.com/jhlagado/z80-tool-services) is for
operations performed on behalf of compilers, assemblers and build tools. The
implementation language does not decide ownership: a TypeScript provider for a
running program belongs here, while a Z80 NOBJ loader belongs with the tools.

General-purpose routines such as formatting, CRCs and memory operations are
not automatically services. They should become separately versioned native
libraries only when real consumers establish a common interface and cost.

## Current state

The first contract is the synchronous byte gateway described in
[`docs/byte-gateway-v0.md`](docs/byte-gateway-v0.md). Its six-call native client
is 18 bytes. The same ATOM consumer is assembled and executed against a bounded
memory provider and an I/O-port provider. Language-neutral vectors also qualify
the host reference provider, reset and failure behaviour.

[`docs/architecture.md`](docs/architecture.md) describes the intended platform,
while [`docs/p2-transport.md`](docs/p2-transport.md) and the `reference/p2-*`
files preserve the existing framed-transport experiment. P2 is one possible
transport; it is not the service abstraction itself.

Run `npm ci` once, then `deno task verify` to check generated projections,
reference providers and native ATOM execution. Measured byte and cycle accounts
are fixed by [`proofs/byte-gateway-v0.json`](proofs/byte-gateway-v0.json).

## Distribution

Tagged releases will contain the contracts, conformance vectors, exact ATOM
sources and a manifest of file hashes. Native consumers can pin and vendor the
small source subset they use. npm may distribute host-side JavaScript later,
but npm is not the native Z80 dependency model.
