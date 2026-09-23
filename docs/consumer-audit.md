# Byte-service consumer audit

This audit freezes the inputs used to shape the first Z80 Services profile. It
separates existing contracts from future requirements and distinguishes
build-tool services from services requested by running programs.

## Revisions inspected

| Project | Revision | Finding |
| --- | --- | --- |
| Atom | `540798c59cf04404e8bb992da50d606cce405edc` | Atom uses Z80 Tool Services from its Node host, but has no shared generated-program service ABI. Assembly programs can become direct consumers of the native client. |
| Nucleus | `6f136e5d974864ef58a1f459212d0b59d1950d31` | Nucleus has a complete six-operation program-service contract, stable status codes, a vector table and native conformance proofs. |
| Skate | `66a1321` | Skate needs console byte input and output. Its runtime currently calls CP/M BDOS directly and maps Control-Z to Scheme EOF. Storage and Scheme port work are planned rather than implemented. |
| Z80 Tool Services | `faf71b22b27e5097cca17fedfb788445ccb5e617` | The tool repository contains a host memory provider, an I/O-port gateway and conformance logic for Nucleus's six operations. These program-facing components belong in Z80 Services. |

## Existing common ground

Nucleus defines these operations and numeric identities:

| Code | Operation | Input | Success |
| ---: | --- | --- | --- |
| `0` | read standard-input byte | none | byte |
| `1` | write standard-output byte | byte | no value |
| `2` | read storage-input byte | none | byte |
| `3` | rewind storage input | none | no value |
| `4` | write storage-output byte | byte | no value |
| `5` | seek storage output | unsigned 16-bit offset | no value |

Its stable failures are EOF `1`, input failure `2`, output failure `3` and
storage failure `4`. Reads advance only on success. Output appends in call
order. Storage output overwrites below its current end, appends at the end and
does not admit a seek beyond the end. Failed operations leave bytes and cursors
unchanged. A new run restores the initial state.

Skate's current console primitives need the first two operations. Its CP/M
adapter currently gives `read-char` the echo and text conventions of BDOS
function 1 and treats Control-Z as EOF. Those are CP/M policy choices rather
than universal byte-stream semantics. A Skate adapter must perform that mapping
without placing Control-Z or BDOS behaviour in the shared contract.

Atom contributes no additional operation today. Its important requirement is
that a standalone ATOM program can call the service without depending on a
language runtime or Node during execution.

## Selected first profile

Version zero retains the six proven operations as a **byte gateway** profile.
This is a compact profile of standard roles, not the eventual general Scheme
port or file-handle interface. It gives Nucleus a direct migration, gives Skate
the two console operations it presently needs, and gives Atom programs a small
native surface.

The native convention follows the existing Nucleus service ABI:

- reads take no argument and return the byte in `A` with carry clear;
- byte writes take the byte in `A` and return carry clear on success;
- rewind takes no argument and returns carry clear on success;
- seek takes the unsigned offset in `HL` and returns carry clear on success;
- failures return carry set and the stable status in `A`;
- `IX`, `IY`, the alternate register set and the caller's stack below the
  return address are preserved; other primary registers and arithmetic flags
  are caller-saved.

The client is a six-entry `JP` vector. Its 18 bytes are the entire resident
indirection cost. Providers implement the same six routine contracts behind
that vector. Physical vector placement remains a link or platform decision.

## Deferred work

General stream handles, open and close, named storage, capabilities, terminal
control, events and asynchronous completion remain later profiles. Introducing
handles now would make Nucleus and Skate pay for a model neither currently
uses. The byte gateway does not prevent that later work: it supplies the small
bootstrap channel through which richer profiles can be discovered or carried.

P2 framing also remains separate. It can transport byte-gateway or future
capability requests across a serial boundary after the synchronous native
contract is qualified.
