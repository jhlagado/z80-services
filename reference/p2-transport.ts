/** Bounded, synchronous command/event protocol for terminal and harness providers. */

export const EFFECT_VERSION = 1;
export const EFFECT_MAGIC = Object.freeze([0x1b, 0x7e]);
export const EFFECT_HEADER_BYTES = 9;
export const EFFECT_TRAILER_BYTES = 2;
export const MAX_EFFECT_PAYLOAD_BYTES = 1024;
export const MAX_EFFECT_FRAME_BYTES = EFFECT_HEADER_BYTES +
  MAX_EFFECT_PAYLOAD_BYTES + EFFECT_TRAILER_BYTES;
export const MAX_EFFECT_EVENT_QUEUE = 64;

export type EffectFrameKind = "request" | "response" | "event";

export const EffectFrameKindCode: Readonly<Record<EffectFrameKind, number>> =
  Object.freeze({
    request: 1,
    response: 2,
    event: 3,
  });
const frameKindName: Record<number, EffectFrameKind> = {
  1: "request",
  2: "response",
  3: "event",
};

export type EffectProtocolErrorCode =
  | "malformed"
  | "version"
  | "truncated"
  | "checksum"
  | "capacity"
  | "unsupported"
  | "invalid-command"
  | "invalid-event"
  | "empty"
  | "device";

export class EffectProtocolError extends Error {
  constructor(
    readonly code: EffectProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EffectProtocolError";
  }
}

/** Raised when the synchronous convenience API meets a deferred response. */
export class EffectPendingError extends Error {
  constructor(readonly task: number) {
    super(`Effect request is pending on task ${task}`);
    this.name = "EffectPendingError";
  }
}

export interface EffectLimits {
  readonly maxPayloadBytes: number;
  readonly maxFrameBytes: number;
  readonly maxEventQueue: number;
}

export const DEFAULT_EFFECT_LIMITS: Readonly<EffectLimits> = Object.freeze({
  maxPayloadBytes: MAX_EFFECT_PAYLOAD_BYTES,
  maxFrameBytes: MAX_EFFECT_FRAME_BYTES,
  maxEventQueue: MAX_EFFECT_EVENT_QUEUE,
});

export interface EffectFrame {
  readonly kind: EffectFrameKind;
  readonly opcode: number;
  readonly correlation: number;
  readonly payload: Uint8Array;
}

function integer(value: number, name: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from 0 through ${maximum}`,
    );
  }
}

function taskNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
    throw new RangeError(`${name} must be a task ID from 1 through 65535`);
  }
}

function checkLimits(limits: EffectLimits): void {
  integer(limits.maxPayloadBytes, "maxPayloadBytes", 0xffff);
  integer(limits.maxFrameBytes, "maxFrameBytes", 0xffff);
  integer(limits.maxEventQueue, "maxEventQueue", 0xffff);
  if (limits.maxFrameBytes < EFFECT_HEADER_BYTES + EFFECT_TRAILER_BYTES) {
    throw new RangeError("maxFrameBytes is smaller than an effect frame");
  }
  if (
    limits.maxFrameBytes <
      EFFECT_HEADER_BYTES + Math.min(limits.maxPayloadBytes, 0xffff) +
        EFFECT_TRAILER_BYTES
  ) {
    throw new RangeError("maxFrameBytes cannot hold maxPayloadBytes");
  }
}

function crc16(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff;
  for (let index = start; index < end; index++) {
    crc ^= bytes[index]! << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function writeWord(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8;
}

function readWord(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function validateFrame(frame: EffectFrame, limits: EffectLimits): void {
  checkLimits(limits);
  if (!(frame.payload instanceof Uint8Array)) {
    throw new EffectProtocolError("malformed", "Frame payload must be bytes");
  }
  if (!(frame.kind in EffectFrameKindCode)) {
    throw new EffectProtocolError("malformed", "Unknown effect frame kind");
  }
  integer(frame.opcode, "opcode", 0xff);
  integer(frame.correlation, "correlation", 0xffff);
  if (frame.payload.length > limits.maxPayloadBytes) {
    throw new EffectProtocolError(
      "capacity",
      `Effect payload exceeds ${limits.maxPayloadBytes} bytes`,
    );
  }
}

/** Encode one complete request, response, or reserved event frame. */
export function encodeEffectFrame(
  frame: EffectFrame,
  limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
): Uint8Array {
  validateFrame(frame, limits);
  const size = EFFECT_HEADER_BYTES + frame.payload.length +
    EFFECT_TRAILER_BYTES;
  if (size > limits.maxFrameBytes) {
    throw new EffectProtocolError(
      "capacity",
      `Effect frame exceeds ${limits.maxFrameBytes} bytes`,
    );
  }
  const bytes = new Uint8Array(size);
  bytes.set(EFFECT_MAGIC, 0);
  bytes[2] = EFFECT_VERSION;
  bytes[3] = EffectFrameKindCode[frame.kind];
  bytes[4] = frame.opcode;
  writeWord(bytes, 5, frame.correlation);
  writeWord(bytes, 7, frame.payload.length);
  bytes.set(frame.payload, EFFECT_HEADER_BYTES);
  writeWord(bytes, size - EFFECT_TRAILER_BYTES, crc16(bytes, 2, size - 2));
  return bytes;
}

/** Decode exactly one complete frame. Trailing bytes are rejected. */
export function decodeEffectFrame(
  bytes: Uint8Array,
  limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
): EffectFrame {
  checkLimits(limits);
  if (!(bytes instanceof Uint8Array)) {
    throw new EffectProtocolError("malformed", "Effect frame must be bytes");
  }
  if (bytes.length < EFFECT_HEADER_BYTES + EFFECT_TRAILER_BYTES) {
    throw new EffectProtocolError("truncated", "Effect frame is incomplete");
  }
  if (bytes[0] !== EFFECT_MAGIC[0] || bytes[1] !== EFFECT_MAGIC[1]) {
    throw new EffectProtocolError(
      "malformed",
      "Effect frame marker is invalid",
    );
  }
  if (bytes[2] !== EFFECT_VERSION) {
    throw new EffectProtocolError(
      "version",
      `Unsupported effect protocol version ${bytes[2]}`,
    );
  }
  const kind = frameKindName[bytes[3]!];
  if (kind === undefined) {
    throw new EffectProtocolError("malformed", "Effect frame kind is invalid");
  }
  const payloadLength = readWord(bytes, 7);
  if (payloadLength > limits.maxPayloadBytes) {
    throw new EffectProtocolError(
      "capacity",
      `Effect payload exceeds ${limits.maxPayloadBytes} bytes`,
    );
  }
  const expected = EFFECT_HEADER_BYTES + payloadLength + EFFECT_TRAILER_BYTES;
  if (expected > limits.maxFrameBytes) {
    throw new EffectProtocolError(
      "capacity",
      `Effect frame exceeds ${limits.maxFrameBytes} bytes`,
    );
  }
  if (bytes.length < expected) {
    throw new EffectProtocolError(
      "truncated",
      "Effect frame payload is incomplete",
    );
  }
  if (bytes.length !== expected) {
    throw new EffectProtocolError(
      "malformed",
      "Effect frame has trailing bytes",
    );
  }
  const actualCrc = readWord(bytes, expected - EFFECT_TRAILER_BYTES);
  const expectedCrc = crc16(bytes, 2, expected - EFFECT_TRAILER_BYTES);
  if (actualCrc !== expectedCrc) {
    throw new EffectProtocolError(
      "checksum",
      "Effect frame checksum is invalid",
    );
  }
  return Object.freeze({
    kind,
    opcode: bytes[4]!,
    correlation: readWord(bytes, 5),
    payload: bytes.slice(EFFECT_HEADER_BYTES, expected - EFFECT_TRAILER_BYTES),
  });
}

/** Incremental decoder used by serial transports that deliver partial chunks. */
export class EffectFrameDecoder {
  private buffer = new Uint8Array(0);

  constructor(private readonly limits: EffectLimits = DEFAULT_EFFECT_LIMITS) {
    checkLimits(limits);
  }

  push(chunk: Uint8Array): EffectFrame[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new EffectProtocolError("malformed", "Effect input must be bytes");
    }
    if (chunk.length === 0) return [];
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;
    const frames: EffectFrame[] = [];
    for (;;) {
      if (this.buffer.length < EFFECT_HEADER_BYTES) return frames;
      if (
        this.buffer[0] !== EFFECT_MAGIC[0] ||
        this.buffer[1] !== EFFECT_MAGIC[1]
      ) {
        throw new EffectProtocolError(
          "malformed",
          "Effect frame marker is invalid",
        );
      }
      const payloadLength = readWord(this.buffer, 7);
      const expected = EFFECT_HEADER_BYTES + payloadLength +
        EFFECT_TRAILER_BYTES;
      if (
        payloadLength > this.limits.maxPayloadBytes ||
        expected > this.limits.maxFrameBytes
      ) {
        throw new EffectProtocolError(
          "capacity",
          "Effect frame exceeds limits",
        );
      }
      if (this.buffer.length < expected) return frames;
      frames.push(
        decodeEffectFrame(this.buffer.slice(0, expected), this.limits),
      );
      this.buffer = this.buffer.slice(expected);
      if (this.buffer.length === 0) return frames;
    }
  }

  finish(): void {
    if (this.buffer.length !== 0) {
      throw new EffectProtocolError(
        "truncated",
        "Effect stream ended mid-frame",
      );
    }
  }
}

export const EffectCommandOpcode = Object.freeze({
  text: 1,
  control: 2,
  readEvent: 3,
  query: 4,
  poll: 5,
});

export type EffectReadMode = "normalized" | "raw";

export type EffectCommand =
  | { readonly type: "text"; readonly bytes: Uint8Array }
  | {
    readonly type: "control";
    readonly capability: number;
    readonly bytes: Uint8Array;
  }
  | { readonly type: "read-event"; readonly mode: EffectReadMode }
  | {
    readonly type: "query";
    readonly capability: number;
    readonly bytes: Uint8Array;
  }
  | { readonly type: "poll"; readonly task: number };

function checkedBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new EffectProtocolError("invalid-command", `${label} must be bytes`);
  }
  return value;
}

function commandPayload(command: EffectCommand): Uint8Array {
  switch (command.type) {
    case "text":
      return checkedBytes(command.bytes, "text").slice();
    case "control":
    case "query": {
      integer(command.capability, "capability", 0xffff);
      const bytes = checkedBytes(command.bytes, command.type).slice();
      const payload = new Uint8Array(bytes.length + 2);
      writeWord(payload, 0, command.capability);
      payload.set(bytes, 2);
      return payload;
    }
    case "read-event":
      return Uint8Array.of(command.mode === "raw" ? 1 : 0);
    case "poll": {
      taskNumber(command.task, "task");
      const payload = new Uint8Array(2);
      writeWord(payload, 0, command.task);
      return payload;
    }
  }
}

export function encodeEffectCommand(
  command: EffectCommand,
  correlation: number,
  limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
): Uint8Array {
  const opcode = command.type === "read-event"
    ? EffectCommandOpcode.readEvent
    : EffectCommandOpcode[command.type];
  return encodeEffectFrame({
    kind: "request",
    opcode,
    correlation,
    payload: commandPayload(command),
  }, limits);
}

export function decodeEffectCommand(frame: EffectFrame): EffectCommand {
  if (frame.kind !== "request") {
    throw new EffectProtocolError(
      "invalid-command",
      "Expected an effect request",
    );
  }
  const payload = frame.payload;
  switch (frame.opcode) {
    case EffectCommandOpcode.text:
      return { type: "text", bytes: payload.slice() };
    case EffectCommandOpcode.control:
    case EffectCommandOpcode.query:
      if (payload.length < 2) {
        throw new EffectProtocolError(
          "invalid-command",
          "Capability command needs a two-byte handle",
        );
      }
      return {
        type: frame.opcode === EffectCommandOpcode.control
          ? "control"
          : "query",
        capability: readWord(payload, 0),
        bytes: payload.slice(2),
      };
    case EffectCommandOpcode.readEvent:
      if (payload.length !== 1 || (payload[0] !== 0 && payload[0] !== 1)) {
        throw new EffectProtocolError(
          "invalid-command",
          "read-event needs a normalized/raw mode byte",
        );
      }
      return {
        type: "read-event",
        mode: payload[0] === 1 ? "raw" : "normalized",
      };
    case EffectCommandOpcode.poll:
      if (payload.length !== 2) {
        throw new EffectProtocolError(
          "invalid-command",
          "poll needs a two-byte task ID",
        );
      }
      {
        const task = readWord(payload, 0);
        if (task === 0) {
          throw new EffectProtocolError(
            "invalid-command",
            "poll task ID must be nonzero",
          );
        }
        return { type: "poll", task };
      }
    default:
      throw new EffectProtocolError(
        "unsupported",
        `Unsupported effect command opcode ${frame.opcode}`,
      );
  }
}

export type EffectResponse =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "empty" }
  | { readonly status: "pending"; readonly task: number }
  | {
    readonly status: "error";
    readonly code: EffectProtocolErrorCode;
    readonly message: string;
  };

export const EffectResponseStatus = Object.freeze({
  ok: 0,
  empty: 1,
  error: 2,
  pending: 3,
});
const responseStatusName: Record<
  number,
  "ok" | "empty" | "error" | "pending"
> = {
  0: "ok",
  1: "empty",
  2: "error",
  3: "pending",
};
export const EffectErrorCode = Object.freeze(
  {
    malformed: 0,
    version: 1,
    truncated: 2,
    checksum: 3,
    capacity: 4,
    unsupported: 5,
    "invalid-command": 6,
    "invalid-event": 7,
    empty: 8,
    device: 9,
  } satisfies Record<EffectProtocolErrorCode, number>,
);
const errorCodeList = Object.freeze(
  [
    "malformed",
    "version",
    "truncated",
    "checksum",
    "capacity",
    "unsupported",
    "invalid-command",
    "invalid-event",
    "empty",
    "device",
  ] satisfies EffectProtocolErrorCode[],
);

function errorCodeIndex(code: EffectProtocolErrorCode): number {
  const index = errorCodeList.indexOf(code);
  return index < 0 ? 0 : index;
}

export function encodeEffectResponse(
  response: EffectResponse,
  correlation: number,
  opcode: number,
  limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
): Uint8Array {
  let payload: Uint8Array;
  if (response.status === "ok") {
    payload = new Uint8Array(response.bytes.length + 1);
    payload[0] = EffectResponseStatus.ok;
    payload.set(response.bytes, 1);
  } else if (response.status === "empty") {
    payload = Uint8Array.of(EffectResponseStatus.empty);
  } else if (response.status === "pending") {
    taskNumber(response.task, "task");
    payload = new Uint8Array(3);
    payload[0] = EffectResponseStatus.pending;
    writeWord(payload, 1, response.task);
  } else {
    const message = new TextEncoder().encode(response.message);
    payload = new Uint8Array(message.length + 2);
    payload[0] = EffectResponseStatus.error;
    payload[1] = errorCodeIndex(response.code);
    payload.set(message, 2);
  }
  return encodeEffectFrame({
    kind: "response",
    opcode,
    correlation,
    payload,
  }, limits);
}

export function decodeEffectResponse(frame: EffectFrame): EffectResponse {
  if (frame.kind !== "response" || frame.payload.length < 1) {
    throw new EffectProtocolError(
      "malformed",
      "Expected a nonempty effect response",
    );
  }
  const status = responseStatusName[frame.payload[0]!];
  if (status === undefined) {
    throw new EffectProtocolError(
      "malformed",
      "Effect response status is invalid",
    );
  }
  if (status === "ok") return { status, bytes: frame.payload.slice(1) };
  if (status === "empty") {
    if (frame.payload.length !== 1) {
      throw new EffectProtocolError(
        "malformed",
        "Empty response has a payload",
      );
    }
    return { status };
  }
  if (status === "pending") {
    if (frame.payload.length !== 3) {
      throw new EffectProtocolError(
        "malformed",
        "Pending response needs one task ID",
      );
    }
    const task = readWord(frame.payload, 1);
    if (task === 0) {
      throw new EffectProtocolError(
        "malformed",
        "Pending response task ID must be nonzero",
      );
    }
    return { status, task };
  }
  if (frame.payload.length < 2) {
    throw new EffectProtocolError(
      "malformed",
      "Error response lacks an error code",
    );
  }
  const code = errorCodeList[frame.payload[1]!];
  if (code === undefined) {
    throw new EffectProtocolError(
      "malformed",
      "Error response code is invalid",
    );
  }
  return {
    status,
    code,
    message: new TextDecoder().decode(frame.payload.slice(2)),
  };
}

export type EffectEvent =
  | {
    readonly type: "text";
    readonly source: number;
    readonly sequence: number;
    readonly text: string;
  }
  | {
    readonly type: "key";
    readonly source: number;
    readonly sequence: number;
    readonly key: string;
    readonly modifiers: number;
    readonly text?: string;
  }
  | {
    readonly type: "pointer";
    readonly source: number;
    readonly sequence: number;
    readonly x: number;
    readonly y: number;
    readonly buttons: number;
  }
  | {
    readonly type: "timer";
    readonly source: number;
    readonly sequence: number;
    readonly ticks: number;
  }
  | {
    readonly type: "device";
    readonly source: number;
    readonly sequence: number;
    readonly status: number;
    readonly bytes: Uint8Array;
  }
  | {
    readonly type: "data";
    readonly source: number;
    readonly sequence: number;
    readonly bytes: Uint8Array;
  }
  | {
    readonly type: "raw";
    readonly source: number;
    readonly sequence: number;
    readonly bytes: Uint8Array;
  }
  | {
    readonly type: "error";
    readonly source: number;
    readonly sequence: number;
    readonly code: number;
    readonly message: string;
  };

export const EffectEventTypeCode = Object.freeze({
  text: 1,
  key: 2,
  pointer: 3,
  timer: 4,
  device: 5,
  data: 6,
  raw: 7,
  error: 8,
});
const eventTypeName: Record<number, EffectEvent["type"]> = {
  1: "text",
  2: "key",
  3: "pointer",
  4: "timer",
  5: "device",
  6: "data",
  7: "raw",
  8: "error",
};

function utf8(value: string, label: string): Uint8Array {
  if (typeof value !== "string") {
    throw new EffectProtocolError("invalid-event", `${label} must be text`);
  }
  return new TextEncoder().encode(value);
}

function writeSignedWord(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  writeWord(bytes, offset, signedWord(value));
}

function signedWord(value: number): number {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new EffectProtocolError(
      "invalid-event",
      "signed event coordinate must be from -32768 through 32767",
    );
  }
  return value < 0 ? value + 0x10000 : value;
}

function readSignedWord(bytes: Uint8Array, offset: number): number {
  const value = readWord(bytes, offset);
  return value < 0x8000 ? value : value - 0x10000;
}

function readTextField(
  bytes: Uint8Array,
  offset: number,
): { readonly value: string; readonly next: number } {
  if (offset + 2 > bytes.length) {
    throw new EffectProtocolError(
      "invalid-event",
      "Event text length is truncated",
    );
  }
  const length = readWord(bytes, offset);
  const end = offset + 2 + length;
  if (end > bytes.length) {
    throw new EffectProtocolError("invalid-event", "Event text is truncated");
  }
  return {
    value: new TextDecoder().decode(bytes.slice(offset + 2, end)),
    next: end,
  };
}

/** Encode a normalized event or a raw byte event for a read-event response. */
export function encodeEffectEvent(
  event: EffectEvent,
  limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
): Uint8Array {
  integer(event.source, "event source", 0xffff);
  integer(event.sequence, "event sequence", 0xffff);
  let size = 5;
  let textData: Uint8Array | undefined;
  let keyData: Uint8Array | undefined;
  let keyText: Uint8Array | undefined;
  let eventBytes: Uint8Array | undefined;
  if (event.type === "text") {
    textData = utf8(event.text, "event text");
    size += 2 + textData.length;
  } else if (event.type === "key") {
    keyData = utf8(event.key, "event key");
    keyText = event.text === undefined
      ? undefined
      : utf8(event.text, "event text");
    integer(event.modifiers, "event modifiers", 0xff);
    size += 1 + 2 + keyData.length + 2 + (keyText?.length ?? 0);
  } else if (event.type === "pointer") {
    signedWord(event.x);
    signedWord(event.y);
    integer(event.buttons, "event buttons", 0xff);
    size += 5;
  } else if (event.type === "timer") {
    integer(event.ticks, "event ticks", 0xffffffff);
    size += 4;
  } else if (event.type === "device") {
    integer(event.status, "device status", 0xff);
    eventBytes = checkedBytes(event.bytes, "device bytes");
    size += 1 + 2 + eventBytes.length;
  } else if (event.type === "data" || event.type === "raw") {
    eventBytes = checkedBytes(event.bytes, `${event.type} bytes`);
    size += 2 + eventBytes.length;
  } else {
    integer(event.code, "event error code", 0xff);
    const message = utf8(event.message, "event error message");
    eventBytes = message;
    size += 1 + 2 + message.length;
  }
  if (size > limits.maxPayloadBytes) {
    throw new EffectProtocolError(
      "capacity",
      "Effect event exceeds payload capacity",
    );
  }
  const payload = new Uint8Array(size);
  payload[0] = EffectEventTypeCode[event.type];
  writeWord(payload, 1, event.source);
  writeWord(payload, 3, event.sequence);
  let cursor = 5;
  if (event.type === "text") {
    writeWord(payload, cursor, textData!.length);
    payload.set(textData!, cursor + 2);
  } else if (event.type === "key") {
    payload[cursor++] = event.modifiers;
    writeWord(payload, cursor, keyData!.length);
    cursor += 2;
    payload.set(keyData!, cursor);
    cursor += keyData!.length;
    writeWord(payload, cursor, keyText?.length ?? 0xffff);
    if (keyText !== undefined) payload.set(keyText, cursor + 2);
  } else if (event.type === "pointer") {
    writeSignedWord(payload, cursor, event.x);
    writeSignedWord(payload, cursor + 2, event.y);
    payload[cursor + 4] = event.buttons;
  } else if (event.type === "timer") {
    payload[cursor] = event.ticks & 0xff;
    payload[cursor + 1] = (event.ticks >>> 8) & 0xff;
    payload[cursor + 2] = (event.ticks >>> 16) & 0xff;
    payload[cursor + 3] = event.ticks >>> 24;
  } else if (event.type === "device") {
    payload[cursor++] = event.status;
    writeWord(payload, cursor, eventBytes!.length);
    payload.set(eventBytes!, cursor + 2);
  } else if (event.type === "data" || event.type === "raw") {
    writeWord(payload, cursor, eventBytes!.length);
    payload.set(eventBytes!, cursor + 2);
  } else {
    payload[cursor++] = event.code;
    writeWord(payload, cursor, eventBytes!.length);
    payload.set(eventBytes!, cursor + 2);
  }
  return payload;
}

export function decodeEffectEvent(payload: Uint8Array): EffectEvent {
  if (!(payload instanceof Uint8Array) || payload.length < 5) {
    throw new EffectProtocolError(
      "invalid-event",
      "Event payload is truncated",
    );
  }
  const type = eventTypeName[payload[0]!];
  if (type === undefined) {
    throw new EffectProtocolError("invalid-event", "Event type is unsupported");
  }
  const source = readWord(payload, 1);
  const sequence = readWord(payload, 3);
  let cursor = 5;
  if (type === "text") {
    const text = readTextField(payload, cursor);
    if (text.next !== payload.length) {
      throw new EffectProtocolError(
        "invalid-event",
        "Text event has trailing bytes",
      );
    }
    return { type, source, sequence, text: text.value };
  }
  if (type === "key") {
    if (cursor + 3 > payload.length) {
      throw new EffectProtocolError("invalid-event", "Key event is truncated");
    }
    const modifiers = payload[cursor++]!;
    const key = readTextField(payload, cursor);
    cursor = key.next;
    if (cursor + 2 > payload.length) {
      throw new EffectProtocolError(
        "invalid-event",
        "Key text length is truncated",
      );
    }
    const textLength = readWord(payload, cursor);
    cursor += 2;
    if (textLength !== 0xffff && cursor + textLength !== payload.length) {
      throw new EffectProtocolError("invalid-event", "Key text is malformed");
    }
    if (textLength === 0xffff) {
      if (cursor !== payload.length) {
        throw new EffectProtocolError(
          "invalid-event",
          "Key event has trailing bytes",
        );
      }
      return { type, source, sequence, key: key.value, modifiers };
    }
    if (cursor + textLength > payload.length) {
      throw new EffectProtocolError("invalid-event", "Key text is truncated");
    }
    return {
      type,
      source,
      sequence,
      key: key.value,
      modifiers,
      text: new TextDecoder().decode(
        payload.slice(cursor, cursor + textLength),
      ),
    };
  }
  if (type === "pointer") {
    if (payload.length !== cursor + 5) {
      throw new EffectProtocolError(
        "invalid-event",
        "Pointer event size is invalid",
      );
    }
    return {
      type,
      source,
      sequence,
      x: readSignedWord(payload, cursor),
      y: readSignedWord(payload, cursor + 2),
      buttons: payload[cursor + 4]!,
    };
  }
  if (type === "timer") {
    if (payload.length !== cursor + 4) {
      throw new EffectProtocolError(
        "invalid-event",
        "Timer event size is invalid",
      );
    }
    return {
      type,
      source,
      sequence,
      ticks: (payload[cursor]! | (payload[cursor + 1]! << 8) |
        (payload[cursor + 2]! << 16) | (payload[cursor + 3]! << 24)) >>> 0,
    };
  }
  if (type === "device") {
    if (cursor + 3 > payload.length) {
      throw new EffectProtocolError(
        "invalid-event",
        "Device event is truncated",
      );
    }
    const status = payload[cursor++]!;
    const length = readWord(payload, cursor);
    cursor += 2;
    if (cursor + length !== payload.length) {
      throw new EffectProtocolError(
        "invalid-event",
        "Device event size is invalid",
      );
    }
    return { type, source, sequence, status, bytes: payload.slice(cursor) };
  }
  if (type === "data" || type === "raw") {
    if (cursor + 2 > payload.length) {
      throw new EffectProtocolError("invalid-event", "Byte event is truncated");
    }
    const length = readWord(payload, cursor);
    cursor += 2;
    if (cursor + length !== payload.length) {
      throw new EffectProtocolError(
        "invalid-event",
        "Byte event size is invalid",
      );
    }
    return { type, source, sequence, bytes: payload.slice(cursor) };
  }
  if (cursor + 3 > payload.length) {
    throw new EffectProtocolError("invalid-event", "Error event is truncated");
  }
  const code = payload[cursor++]!;
  const length = readWord(payload, cursor);
  cursor += 2;
  if (cursor + length !== payload.length) {
    throw new EffectProtocolError(
      "invalid-event",
      "Error event size is invalid",
    );
  }
  return {
    type,
    source,
    sequence,
    code,
    message: new TextDecoder().decode(payload.slice(cursor)),
  };
}

export interface EffectProvider {
  handle(request: EffectFrame): EffectFrame;
}

export interface EffectTransport {
  transact(request: Uint8Array): Uint8Array;
}

/** Adapter used by tests and modern harnesses to exercise the wire contract. */
export class ProviderTransport implements EffectTransport {
  constructor(
    private readonly provider: EffectProvider,
    private readonly limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
  ) {}

  transact(request: Uint8Array): Uint8Array {
    const frame = decodeEffectFrame(request, this.limits);
    return encodeEffectFrame(this.provider.handle(frame), this.limits);
  }
}

/** Synchronous client: one request is sent and one response is received. */
export class EffectClient {
  private nextCorrelation = 1;

  constructor(
    private readonly transport: EffectTransport,
    private readonly limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
  ) {}

  request(command: EffectCommand): EffectResponse {
    const correlation = this.nextCorrelation;
    this.nextCorrelation = this.nextCorrelation === 0xffff
      ? 1
      : this.nextCorrelation + 1;
    const request = encodeEffectCommand(command, correlation, this.limits);
    const responseFrame = decodeEffectFrame(
      this.transport.transact(request),
      this.limits,
    );
    if (
      responseFrame.kind !== "response" ||
      responseFrame.correlation !== correlation
    ) {
      throw new EffectProtocolError(
        "malformed",
        "Effect response correlation does not match request",
      );
    }
    if (responseFrame.opcode !== commandOpcode(command)) {
      throw new EffectProtocolError(
        "malformed",
        "Effect response opcode does not match request",
      );
    }
    return decodeEffectResponse(responseFrame);
  }

  sendText(text: string): void {
    const response = this.request({ type: "text", bytes: utf8(text, "text") });
    requireOk(response);
  }

  sendControl(capability: number, bytes: Uint8Array): void {
    requireOk(this.request({ type: "control", capability, bytes }));
  }

  readEvent(mode: EffectReadMode = "normalized"): EffectEvent | null {
    const response = this.request({ type: "read-event", mode });
    if (response.status === "empty") return null;
    if (response.status === "pending") {
      throw new EffectPendingError(response.task);
    }
    if (response.status === "error") {
      throw new EffectProtocolError(response.code, response.message);
    }
    return decodeEffectEvent(response.bytes);
  }

  query(capability: number, bytes: Uint8Array): Uint8Array {
    const response = this.request({ type: "query", capability, bytes });
    return requireOk(response);
  }

  poll(task: number): EffectResponse {
    return this.request({ type: "poll", task });
  }
}

function commandOpcode(command: EffectCommand): number {
  return command.type === "read-event"
    ? EffectCommandOpcode.readEvent
    : EffectCommandOpcode[command.type];
}

function requireOk(response: EffectResponse): Uint8Array {
  if (response.status === "ok") return response.bytes;
  if (response.status === "empty") {
    throw new EffectProtocolError(
      "empty",
      "Effect provider returned no result",
    );
  }
  if (response.status === "pending") {
    throw new EffectPendingError(response.task);
  }
  throw new EffectProtocolError(response.code, response.message);
}

export interface RecordedControl {
  readonly capability: number;
  readonly bytes: Uint8Array;
}

/** Deterministic reference provider for protocol and Triptych harness tests. */
export class RecordingEffectProvider implements EffectProvider {
  readonly textWrites: Uint8Array[] = [];
  readonly controls: RecordedControl[] = [];
  private readonly events: EffectEvent[] = [];
  private readonly queries = new Map<string, Uint8Array>();

  constructor(private readonly limits: EffectLimits = DEFAULT_EFFECT_LIMITS) {
    checkLimits(limits);
  }

  queueEvent(event: EffectEvent): void {
    if (this.events.length >= this.limits.maxEventQueue) {
      throw new EffectProtocolError("capacity", "Effect event queue is full");
    }
    const encoded = encodeEffectEvent(event, this.limits);
    if (encoded.length + 1 > this.limits.maxPayloadBytes) {
      throw new EffectProtocolError(
        "capacity",
        "Effect event does not fit in a response frame",
      );
    }
    this.events.push(decodeEffectEvent(encoded));
  }

  setQueryReply(
    capability: number,
    request: Uint8Array,
    reply: Uint8Array,
  ): void {
    integer(capability, "capability", 0xffff);
    const key = `${capability}:${hex(request)}`;
    this.queries.set(key, checkedBytes(reply, "query reply").slice());
  }

  handle(request: EffectFrame): EffectFrame {
    try {
      const command = decodeEffectCommand(request);
      let response: EffectResponse;
      if (command.type === "text") {
        this.textWrites.push(command.bytes.slice());
        response = { status: "ok", bytes: new Uint8Array(0) };
      } else if (command.type === "control") {
        this.controls.push({
          capability: command.capability,
          bytes: command.bytes.slice(),
        });
        response = { status: "ok", bytes: new Uint8Array(0) };
      } else if (command.type === "read-event") {
        const event = this.events[0];
        if (event === undefined) response = { status: "empty" };
        else if (command.mode === "raw" && event.type !== "raw") {
          response = {
            status: "error",
            code: "device",
            message: "Raw mode needs a raw event",
          };
        } else if (command.mode === "normalized" && event.type === "raw") {
          response = {
            status: "error",
            code: "device",
            message: "Normalized mode received a raw event",
          };
        } else {
          this.events.shift();
          response = {
            status: "ok",
            bytes: encodeEffectEvent(event, this.limits),
          };
        }
      } else if (command.type === "poll") {
        response = {
          status: "error",
          code: "unsupported",
          message: "Recording provider does not defer effect requests",
        };
      } else {
        const reply = this.queries.get(
          `${command.capability}:${hex(command.bytes)}`,
        );
        response = reply === undefined
          ? { status: "error", code: "device", message: "No query reply" }
          : { status: "ok", bytes: reply.slice() };
      }
      return decodeEffectFrame(
        encodeEffectResponse(
          response,
          request.correlation,
          request.opcode,
          this.limits,
        ),
        this.limits,
      );
    } catch (error) {
      const protocol = error instanceof EffectProtocolError
        ? error
        : new EffectProtocolError("malformed", String(error));
      return decodeEffectFrame(
        encodeEffectResponse(
          { status: "error", code: protocol.code, message: protocol.message },
          request.correlation,
          request.opcode,
          this.limits,
        ),
        this.limits,
      );
    }
  }
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
