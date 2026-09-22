# Conformance

This directory will hold language-neutral vectors that can be exercised by
host providers and native ATOM clients. A service profile is not stable merely
because its constants agree: the implementations must also agree about
results, state changes, capacity, EOF, reset and failure behaviour.

The current P2 tests remain beside their reference implementation. The first
cross-language vectors will cover the synchronous byte gateway.
