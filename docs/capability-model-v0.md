# Capability model v0

A capability instance is one provider's available implementation of a service
profile. Capabilities keep optional hardware out of the language core while
giving a target profile a precise way to list the facilities it supplies.

The v0 model describes static manifests. It does not define a guest-visible
query operation. A later query profile must specify its encoding and failure
behaviour before a running program can discover capabilities at run time.

## Profile and instance

A **service profile** is the normative contract. A **capability instance** is a
particular provider of that contract. Several instances may implement one
profile, for example two independent byte stores. The instance identifier is
opaque and has no CP/M drive or hardware-port meaning.

The existing v0 contract keeps the `byteGateway` profile identifier for
compatibility. New profile identifiers should use lower-case owner-qualified
segments in the form `<owner>.<class>.<name>`, with letters, digits and hyphens.
Identifiers are never reused for a different contract.

## Descriptor

A static capability descriptor has these fields:

| Field | Meaning |
| --- | --- |
| profile identifier | The service profile implemented by the instance. |
| profile version | The semantic version of that profile. |
| instance identifier | An opaque name for this provider instance. |
| binding identifier | The call convention or transport used by the instance. |
| binding version | The compatible version of that binding. |
| operations | The operations supported by this instance. |
| limits | Values with named units such as bytes, handles or dimensions. |
| status map | The results defined by the service profile. |
| lifetime | Creation, reset, close and persistence rules. |
| execution mode | Synchronous or pending behaviour for each operation. |

The descriptor reports guest-visible behaviour. It does not expose a physical
port number, register layout or implementation language.

## Required and optional services

A target profile marks each service profile as required or optional. A
target selection or launcher may require a capability and reject a profile that
does not list it. A general program may use a target-specific fallback when an
optional profile is absent. Guest-side probing requires the future query
profile.

There is no generic `unsupported` status in the current contract. Each future
service profile must define the result and encoding for an unknown operation,
version or capability. The byte gateway retains its existing status values and
uses its invalid result for an invalid gateway operation; that result is not a
universal status for other profiles.

## Device profiles

Terminal control, input events, video and sound are separate capabilities.
Their useful operations and limits differ, so a generic `device` capability is
not sufficient.

A future video profile may describe indexed bitmap, tile or sprite operations.
It must state the mode, dimensions, palette, storage limits and publication
semantics. A TMS9918 or Triptych provider can translate those operations to its
own registers and memory without exposing them to Skate source.

The existence of a TypeScript model or a physical device is not conformance.
The guest-visible provider, its binding and its vectors must satisfy the
capability contract.
