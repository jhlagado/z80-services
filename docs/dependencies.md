# Depending on Z80 Services

## Native programs

Native consumers should pin an immutable Z80 Services release and vendor only
the source files they use. For byte gateway version zero the minimum portable
set is:

- `native/include/z80-services-v0.asmi`;
- `native/client/byte-gateway.asm`;
- the consumer's platform provider.

Record the release tag and the SHA-256 of the release tar. A simple native lock
record can be kept beside the build:

```text
z80-services 0.1.0
profile byteGateway/0
bundle-sha256 <value from z80-services-0.1.0.sha256>
files native/include/z80-services-v0.asmi native/client/byte-gateway.asm
```

The checked-in sources make builds independent of a package manager and
network access. Updating the pin is an explicit source change followed by the
consumer's own assembly and execution qualification.

## Host providers and tests

The reference TypeScript files are shipped as source. This first release is not
an npm package. A host may vendor them from the tagged bundle or implement the
same language-neutral vectors directly. ATOM and Debug80 are exact, locked
development dependencies used to prove the native sources; native consumers do
not inherit them.

A local path or symlink is useful while changing a provider and consumer
together. It is an override, not a release dependency. Release qualification
must reinstall the recorded revisions and pass from a clean checkout.

## Repository boundary

Z80 Services supplies running-program services. Z80 Tool Services supplies
build-time services. Existing program-stream exports in Z80 Tool Services are
compatibility code and should migrate through a separate deprecation release;
new consumers should use this contract directly.
