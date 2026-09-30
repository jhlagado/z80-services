# Target profile contract v0

Z80 Services describes operations requested by a running program. A target
profile describes the contract that lets that program reach those operations on
a particular system. It is the boundary between a portable service definition
and a machine or operating system.

The profile is deliberately smaller than a machine description. CPU registers,
memory maps, CP/M BIOS and BDOS placement, boot sequence, disk geometry and
device ports remain the responsibility of the target project. A target profile
names the service profiles available to a guest and the binding used to call
them.

## Terms

- A **service profile** defines the meaning of an operation, its arguments,
  results, limits and failure behaviour.
- A **capability instance** is one provider's available implementation of a
  service profile.
- A **target profile** is the build and release declaration of the service
  profiles and bindings selected for a guest.
- A **provider** performs a service on behalf of the program.
- An **adapter** translates a language or operating system interface to the
  service profile.
- A **binding** describes the call convention or transport used by a provider.

The same service profile may have several bindings and providers. A
resident Z80 vector binding or a framed serial binding can carry the same
operation through different providers without sharing an address or a wire
format.

## Profile contents

A target profile records:

| Field | Purpose |
| --- | --- |
| target identifier | Names the target contract and its owner. |
| target version | Selects the compatible target-profile rules. |
| service profiles | Lists required and optional profile identifiers. |
| binding identifiers | Selects the binding and binding version for each profile. |
| provider arrangement | Records whether a provider is resident, built in or external. |
| per-profile limits | Records payload, stream, handle and resource limits. |
| per-profile lifetime | Defines reset, close and persistence behaviour. |
| execution mode | States whether each profile or operation is synchronous or pending. |

The v0 target profile is a static manifest supplied at build or release time.
It is not a guest-visible discovery protocol. The manifest must not claim a
capability merely because a physical device exists. The service must be
available through the selected guest-visible binding.

## Responsibilities

Z80 Services owns the meaning of shared operations and their conformance
vectors. The target project owns the machine and operating-system integration.
The language project owns its source-level interface and its interpretation of
text, characters and higher-level ports.

For example, a CP/M target may implement a byte stream through an adapter
over BDOS, while a Triptych target may route it through a resident gateway or a
serial provider.
Neither implementation puts BDOS calls, Triptych ports or VDP registers into a
language adapter.

## Portability

The portability section distinguishes two properties:

- the same source can be compiled for more than one target profile when the
  source uses only the shared service contract;
- the same binary can run on another target only when its entry convention,
  binding, service versions and resource assumptions are compatible.

An adapter or a rebuild is required when an operating system does not provide
the selected binding. A generic target profile must not imply CP/M, Triptych or
any other particular operating system.

## Installation and discovery

A provider may be built into a runtime, supplied by an operating-system
extension, installed as a resident service or reached through an external
transport. The target profile identifies which arrangement is present. It does
not prescribe a universal driver-loading mechanism.

The base byte gateway remains a small fixed service profile. Its v0 contract
has no guest-visible capability query. Optional services must define their
identifier, version, operations, limits, lifetime, execution mode and status map
before a target can list them as qualified capabilities. A future query profile
will need its own byte encoding, size limits, pagination, atomicity and failure
rules.

## Qualification

A target profile is qualified when:

1. its static manifest and bindings are internally consistent;
2. the language-neutral vectors pass through each selected provider;
3. reset, capacity and failure behaviour match each service profile;
4. the selected runtime, stack and provider storage fit the target profile; and
5. the release records the contract, binding and provider revisions.

Host-model tests establish service semantics. They do not establish native
hardware timing, memory placement or electrical behaviour.
