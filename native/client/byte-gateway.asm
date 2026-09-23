; Stable byte-gateway client vector. Providers define the six ZP_* targets.
; Every entry is a three-byte JP, so the complete client costs 18 bytes.

ZSRDIN:  JP ZP_RDIN
ZSWROUT: JP ZP_WOUT
ZSRDST:  JP ZP_RDST
ZSRWST:  JP ZP_RWST
ZSWRST:  JP ZP_WRST
ZSSKST:  JP ZP_SKST
ZS_VEND:
