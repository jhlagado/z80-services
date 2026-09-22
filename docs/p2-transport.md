# P2 transport experiment

P2 predates the Z80 Services project and is retained as a tested candidate for
carrying service requests over a serial or harness boundary. It is one possible
transport, not the program-service abstraction or the required native ABI. The
synchronous byte gateway will be qualified independently before P2 is adopted
as a transport for it.

P2 defines the boundary between a generated Scheme program and the terminal,
Triptych VDP, or another host harness. The program is a synchronous client. It
sends one bounded request and waits for one bounded response. The provider may
perform the operation through ANSI output, a Triptych-private VDP command, a
device query, or a queued input source, but the Scheme program does not need to
know which provider it is using.

## Wire frame

The protocol is binary so ordinary text and control commands remain
distinguishable even when they share a serial link. Each frame is:

```text
ESC  ~  version  kind  opcode  correlation:u16  payload-length:u16
payload bytes
crc16:u16
```

Words are little-endian. Version one uses `ESC ~` (`1B 7E`) as its marker,
version `1`, and CRC-16/CCITT over the version through the payload. Frame kinds
are request, response, and reserved event. Correlation IDs are matched by the
client; a response with the wrong ID or opcode is a protocol error. The
reference limits are a 1,024-byte payload, a 1,035-byte complete frame, and a
64-event provider queue.

The decoder accepts partial serial chunks and rejects bad markers, versions,
lengths, checksums, trailing bytes, and incomplete frames. A malformed frame is
a checked protocol error. It is not silently treated as terminal text.

## Commands and replies

Version one defines five request opcodes (`1` through `5`):

| Command | Payload | Reply |
| --- | --- | --- |
| `text` | UTF-8 bytes | acknowledgement |
| `control` | capability handle `u16`, then command bytes | acknowledgement |
| `read-event` | `0` for normalized or `1` for raw input | event, empty, or error |
| `query` | capability handle `u16`, then request bytes | bounded data or error |
| `poll` | deferred task handle `u16` | pending, data, empty, or error |

The response payload starts with a status byte: `0` is success, `1` means no
queued event, `2` is an error followed by a stable error code and UTF-8
message, and `3` is pending followed by a task handle `u16`. A provider may
return `pending` for any operation that cannot finish in the current request;
the caller sends `poll` with that handle until the provider returns the stored
result or an error. Task handles are provider-local and are not Scheme values.
A real terminal provider may block while servicing `read-event`; the
deterministic reference provider returns `empty` when its queue is empty so
tests do not block.

The response error codes are `0` malformed, `1` version, `2` truncated, `3`
checksum, `4` capacity, `5` unsupported, `6` invalid-command, `7`
invalid-event, `8` empty, and `9` device. These values are exported by the
reference implementation so a target provider does not have to duplicate an
unstated numbering scheme.

`control` carries the same logical operation whether its bytes are an ANSI
sequence, a Triptych VDP command, or another provider-specific encoding. The
core language does not gain Z80-specific primitives for these operations.

## Input events

Normalized input is the default. Every event carries a source handle and a
16-bit sequence number. The event family includes text, keys with modifiers,
pointer coordinates, timers, device status, data replies, and provider errors.
Raw events carry the original byte sequence, including an ANSI or private
escape sequence, for programs that need device-specific input. A normalized
request never consumes a raw event, and a raw request never silently rewrites
one as a key or text event.

The base client remains synchronous and bounded. `EffectClient.request` sends
one frame and receives one frame; its convenience methods raise
`EffectPendingError` when a provider returns a pending task. P7 adds a host-side
cooperative scheduler for saved task state: each task is explicitly `ready`,
`waiting`, `done` or `failed`, and the scheduler gives ready tasks one turn in
round-robin order. It polls waiting provider tasks between turns. No event
loop, callback ABI, continuation or hardware interrupt is required.

The reference scheduler limits the task table to 64 tasks and one run to
65,535 turns. `DeferredEffectProvider` supplies deterministic pending replies
for tests; a Triptych provider can replace it without changing the frame
format. This is a host/harness extension. Generated COM programs and the
native CP/M compiler remain on the qualified synchronous boundary until a
later target-lowering milestone.

The host reference implementation and deterministic provider are in
`reference/p2-transport.ts`. They are provider-neutral: `EffectClient` talks to
an `EffectTransport`, while `RecordingEffectProvider` records text and control
commands, serves registered query replies, and supplies queued normalized or
raw events. Triptych integration can replace that provider without changing
the client or frame format.
