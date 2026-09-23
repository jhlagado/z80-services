# Conformance

This directory holds language-neutral vectors exercised by host providers and
native ATOM clients. A service profile is not stable merely
because its constants agree: the implementations must also agree about
results, state changes, capacity, EOF, reset and failure behaviour.

`vectors/byte-gateway-v0.json` covers synchronous input, output, storage,
capacity, reset and atomic failure behaviour. The current P2 tests remain
beside their reference implementation.

`projections/nucleus-byte-gateway-v0.json` is the checked compatibility
projection for Nucleus. It makes the ownership boundary explicit: the six
byte-stream services and their status values come from this repository, while
Nucleus keeps its success, trap, far-call and far-jump entries in its own
runtime contract.

`projections/skate-byte-gateway-v0.json` is the smaller Skate projection. It
maps `read-char` and `write-char` to the shared console byte operations while
leaving Control-Z/EOF, echo, line editing and CR/LF policy in Skate's language
adapter. It deliberately does not claim storage, terminal-control, event or
future Scheme-port semantics.
