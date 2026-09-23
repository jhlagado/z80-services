# Byte gateway profile 0

The byte gateway is the first experimental Z80 Services profile. It provides
four fixed byte-stream roles: standard input, standard output, storage input
and storage output. It is synchronous and bounded. Version zero preserves the
service semantics already qualified by Nucleus while the shared native and host
implementations are developed.

## Results

Every operation returns either success or one status byte. Native calls report
success with carry clear. Failure sets carry and returns the status in `A`.

| Status | Name | Meaning |
| ---: | --- | --- |
| `0` | success | The operation completed and committed its state change. |
| `1` | end of input | A readable stream has no remaining byte. |
| `2` | input failure | Standard input failed for a reason other than EOF. |
| `3` | output failure | Standard output could not accept the byte. |
| `4` | storage failure | A storage read, write, rewind or seek failed. |
| `254` | invalid | A host gateway received an unknown operation or malformed argument. |

`invalid` is a gateway result. Correct native calls to one of the six vector
entries do not produce it.

## Operations

### Read standard input

No argument. Success returns the current byte and advances the cursor exactly
once. EOF or failure leaves the cursor unchanged.

### Write standard output

The input byte is in `A`. Success appends it after all earlier successful
writes. Failure leaves the output unchanged.

### Read storage input

No argument. Success returns the current byte and advances the cursor exactly
once. EOF or storage failure leaves the cursor unchanged.

### Rewind storage input

No argument. Success sets the storage-input cursor to zero. Failure leaves it
unchanged.

### Write storage output

The input byte is in `A`. A write below the current end overwrites that byte. A
write at the end appends one byte. It never inserts or truncates. Success
advances the cursor once; failure changes neither bytes nor cursor.

### Seek storage output

The unsigned offset is in `HL`. Zero through the current length, inclusive, is
accepted. A larger offset fails. Success changes only the cursor. Failure
leaves it unchanged.

## Initial state and reset

Standard and storage input begin at offset zero. Standard output begins empty.
Storage output begins with provider-supplied bytes and its cursor at their end.
A reset restores that complete initial state and starts a distinct run.

## Native vector

The portable client exposes six consecutive `JP` entries in operation order.
Each entry is three bytes. The provider destinations must remain callable in
the current memory and bank configuration.

`IX`, `IY`, the alternate register set and the caller's stack below the return
address are preserved. `AF`, `BC`, `DE`, `HL` and their arithmetic flags are
otherwise caller-saved. A provider must complete every failure check before
committing a byte or cursor change.
