# Conformance

This directory holds language-neutral vectors exercised by host providers and
native ATOM clients. A service profile is not stable merely
because its constants agree: the implementations must also agree about
results, state changes, capacity, EOF, reset and failure behaviour.

`vectors/byte-gateway-v0.json` covers synchronous input, output, storage,
capacity, reset and atomic failure behaviour. The current P2 tests remain
beside their reference implementation.
