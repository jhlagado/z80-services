# Bindings and conformance v0

Z80 Services separates three concerns:

1. **Service meaning** defines operations, state changes, limits and results.
2. **Bindings** define registers, vectors, arguments and return conventions.
3. **Transports** carry a binding between a program and a provider.

Changing a binding or transport must not silently change the service meaning.

## Initial implementations and bindings

The current project contains these implementation and binding families:

| Kind | Use |
| --- | --- |
| native vector binding | A compact ATOM client calls resident Z80 service entries. |
| host reference provider | A TypeScript provider exercises the service semantics in tests. |
| framed transport experiment | A bounded frame carries requests for the P2 research path. |

The host reference provider is an implementation, not a binding. The P2 frame
experiment is a transport, not yet a qualified byte-gateway binding. A Triptych
serial provider may use another frame binding after its operation mapping,
identifier and version have been specified.

Every binding specification must state byte order, argument registers or
fields, maximum payload, status encoding, ordering, atomicity, reset behaviour,
reentrancy and whether a call can remain pending. A host execution trace is a
test or control substrate, not automatically a Z80 Services binding.

## Versioning

The release records four independent revisions:

- semantic service-profile version;
- binding or transport version; and
- provider implementation revision.

An additive optional operation may use a new capability or profile version.
Changed semantics require a new version. Numeric identifiers and status values
are never reused. A consumer rejects an unknown required version according to
the selected binding. A future optional profile must define its own checked
unsupported result before it is listed as qualified.

The current release manifest records the contract files and their hashes. It
does not yet define a machine-readable provider revision or binding registry.
Those fields belong in a later manifest revision rather than being implied by
a filename.

## Conformance vectors

The same language-neutral vectors must exercise host and native providers.
They cover:

- successful operations and state changes;
- EOF and capacity limits;
- reset and lifetime rules;
- malformed requests;
- provider failures and atomicity; and
- profile and binding version checks where those checks are defined.

A Triptych provider should run these vectors in its native and WASM paths after
its gateway binding has been defined. That proves the provider integration
against the service contract. It does not prove ESP32 timing, electrical
behaviour or the placement of a production firmware image; those require a
separate machine qualification.

## Release contents

A qualified release contains the normative documents, contract manifest,
generated ATOM and TypeScript projections, conformance vectors, provider
revisions and file hashes. Until provider and binding registries are added, the
release claim is limited to the files, vectors and hashes recorded by the
current manifest.
