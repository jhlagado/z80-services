# Z80 Services architecture

## Purpose

A program should be able to read input, write output and use available devices
without knowing whether it is running under CP/M, MSX-DOS, TRSDOS, Triptych or
a browser harness. Z80 Services defines that boundary. An operating system or
machine supplies a provider, while each language supplies a small adapter that
makes the services natural to use.

The contract must be abstract enough to survive a change of platform and
concrete enough to test. “Terminal output” therefore has defined operations,
limits, results and failure behaviour. A provider may implement it with ANSI
bytes, a TMS9918 display, a memory buffer or a serial connection, but it cannot
silently change the meaning seen by the program.

## Ownership test

Every proposed component has one placement question:

> Is this operation performed on behalf of a compiler or build tool, or is it
> requested by a running generated program?

Build-time source preparation, NOBJ processing and image publication belong to
Z80 Tool Services. Program input, output, storage, events and device access
belong here. This remains true when the build operation happens in Z80 code or
the program provider happens to be written in TypeScript.

Language syntax, compiler lowering, private value layouts and garbage
collection stay in Atom, Nucleus and Skate. BDOS calls, VDP registers and
machine port addresses stay in platform providers. This repository owns only
the meaning shared across those boundaries.

## Layers

The platform has three deliberately separate layers:

1. **Service contracts** define operations, capability profiles, ordering,
   limits, lifetime, EOF and failure behaviour.
2. **Native bindings** define a small call boundary and portable ATOM client
   modules. A platform can use a different internal implementation without
   changing the contract.
3. **Transports and providers** carry requests and perform them. A direct
   resident gateway, I/O ports and the P2 serial frame can all implement the
   same service.

Sharing semantics does not require every machine to use the same physical
address, resident ABI or transport.

## Profiles and capabilities

Programs depend on versioned profiles rather than particular devices. The
initial work starts with bounded synchronous byte streams. Named storage,
terminal control, input events and clocks follow only after the base profile is
qualified. Graphics and sound are later profiles because their useful
operations differ between devices.

A target manifest may list optional service profiles. Target selection can
require a terminal or event source. A specialised program can require a tile or
sprite profile and use a target-specific fallback when it is absent. Guest-side
probing requires the future query profile. The profile remains concrete: its
manifest records a version, limits and supported operations rather than an
unspecified “display”.

The base call is synchronous and bounded. It returns success, EOF or a checked
error. Pending work and cooperative scheduling are separate optional
capabilities; they are not required by small CP/M programs.

## Versioning and distribution

The machine-readable contract assigns numeric identifiers and is the authority
for generated TypeScript and ATOM constants. Conformance vectors test the same
observable behaviour through host and native implementations.

Each release will bundle:

- the normative specification and contract manifest;
- generated TypeScript and ATOM projections;
- provider-neutral ATOM client modules;
- language-neutral conformance vectors;
- a file manifest and hashes.

Consumers pin an immutable release and record the selected modules and bundle
hash. They may vendor those source files so qualified builds remain offline and
reproducible. A local path or symlink is a development override and must not be
used to qualify a release.

## First qualification

The first useful proof is intentionally narrow: one synchronous byte-stream
contract, one memory-backed reference provider, one portable ATOM client and
the same conformance vectors run through both. P2 framing remains a separate
transport experiment until an operation mapping and binding version qualify it
for a service profile. The existing scheduler experiment remains useful
research, but it does not set the shape of the base service ABI.

The contract papers divide the next decisions into four parts:

- [`target-profile-v0.md`](target-profile-v0.md) defines the guest-facing target
  boundary without taking ownership of a machine memory map;
- [`capability-model-v0.md`](capability-model-v0.md) defines optional services
  and their descriptors;
- [`console-and-storage-v0.md`](console-and-storage-v0.md) fixes the byte
  gateway boundary and leaves named files as a separate profile; and
- [`bindings-and-conformance-v0.md`](bindings-and-conformance-v0.md) separates
  service meaning from bindings, transports and release qualification.
