# Console and storage boundary v0

The byte gateway supplies bounded byte streams. This document records the
boundary around that profile so that language adapters and operating-system
providers do not acquire incompatible assumptions.

## Console bytes

The console service transfers bytes. It does not define character encoding,
echo, line editing, CR/LF translation, Control-Z handling or terminal escape
sequences.

Those policies belong to the consumer adapter or to a separate terminal
capability. Skate may expose `read-char`, `write-char`, line input or text-port
operations by adding the required policy above the byte gateway. A provider
must not silently apply those transformations to the shared byte contract.

Standard input and standard output are independent streams. A successful read
advances the input cursor once. A successful write commits the byte once. EOF
and failure leave the relevant cursor or output state unchanged, as specified
by the byte-gateway profile.

In a language interface, **port** names a stream endpoint. It does not mean a
Z80 hardware I/O port.

## Storage bytes

The current storage input and storage output roles are bounded byte streams.
They have no filenames, drives, directories, CP/M FCBs, persistence promise or
record format. They are suitable for a provider-backed byte store and for
qualification of cursor and failure behaviour.

Named files require a separate optional profile. That profile will need opaque
handles, open and close operations, read and write rules, seek and truncation
semantics, capacity limits and failure atomicity. It must not expose CP/M drive
letters or FCB layouts to the shared contract.

File persistence is therefore an external service effect. CP/M, Triptych and
another operating system may implement it differently while preserving the
same language-level port semantics.

## Terminal and device control

Plain console bytes remain distinct from terminal control and device commands.
ANSI sequences, Triptych VDP commands and keyboard-event packets require
separate profiles with explicit limits and error rules. A provider may carry
them over the same physical stream, but the service contract must identify
which operation is being requested.

Triptych's current serial and CP/M surfaces do not by themselves provide a
qualified Z80 Services byte gateway. A future Triptych adapter must document
where the gateway is installed and how guest calls reach it.
