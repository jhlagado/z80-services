# Native byte-gateway client

`client/byte-gateway.asm` is the provider-neutral client. It contains six
consecutive `JP` entries and assembles to 18 bytes. A program calls these stable
labels:

| Label | Operation | Input | Success |
| --- | --- | --- | --- |
| `ZSRDIN` | read standard input | none | byte in `A` |
| `ZSWROUT` | write standard output | byte in `A` | `A=0` |
| `ZSRDST` | read storage input | none | byte in `A` |
| `ZSRWST` | rewind storage input | none | `A=0` |
| `ZSWRST` | write storage output | byte in `A` | `A=0` |
| `ZSSKST` | seek storage output | offset in `HL` | `A=0` |

Success clears carry. EOF or failure sets carry and returns its status in `A`.
Providers implement the six `ZP_*` destinations. The memory and I/O-port
providers here are bounded reference implementations; a platform normally owns
its production provider.

The native test assembles `test/byte-gateway-program.asm` unchanged with each
provider and executes both images under Debug80. It also proves the vector
layout, preserved machine state, provider state transitions and atomic native
failure paths.
