import assert from "node:assert/strict";
import {
  decodeEffectEvent,
  decodeEffectFrame,
  decodeEffectResponse,
  EFFECT_HEADER_BYTES,
  EffectClient,
  EffectCommandOpcode,
  EffectFrameDecoder,
  EffectProtocolError,
  encodeEffectEvent,
  encodeEffectFrame,
  ProviderTransport,
  RecordingEffectProvider,
} from "./p2-transport.ts";

function frameBytes(payload = Uint8Array.of(1, 2, 3)): Uint8Array {
  return encodeEffectFrame({
    kind: "request",
    opcode: 0x22,
    correlation: 7,
    payload,
  });
}

Deno.test("effect frames round-trip through every serial chunk boundary", () => {
  const encoded = frameBytes();
  assert.equal(encoded.length, EFFECT_HEADER_BYTES + 3 + 2);
  assert.deepEqual(decodeEffectFrame(encoded), {
    kind: "request",
    opcode: 0x22,
    correlation: 7,
    payload: Uint8Array.of(1, 2, 3),
  });
  for (let split = 0; split <= encoded.length; split++) {
    const decoder = new EffectFrameDecoder();
    const first = decoder.push(encoded.slice(0, split));
    const second = decoder.push(encoded.slice(split));
    assert.deepEqual([...first, ...second], [decodeEffectFrame(encoded)]);
    decoder.finish();
  }
});

Deno.test("effect framing rejects malformed, truncated, corrupt and oversized input", () => {
  assert.throws(
    () => decodeEffectFrame(frameBytes().slice(0, -1)),
    (error) =>
      error instanceof EffectProtocolError && error.code === "truncated",
  );
  const corrupt = frameBytes();
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(
    () => decodeEffectFrame(corrupt),
    (error) =>
      error instanceof EffectProtocolError && error.code === "checksum",
  );
  assert.throws(
    () => decodeEffectFrame(Uint8Array.of(1, 2, 3)),
    (error) =>
      error instanceof EffectProtocolError && error.code === "truncated",
  );
  assert.throws(
    () =>
      encodeEffectFrame({
        kind: "request",
        opcode: 1,
        correlation: 1,
        payload: new Uint8Array(1025),
      }),
    (error) =>
      error instanceof EffectProtocolError && error.code === "capacity",
  );
});

Deno.test("all normalized and raw event forms preserve their fields", () => {
  const events = [
    { type: "text", source: 1, sequence: 2, text: "é" },
    { type: "key", source: 3, sequence: 4, key: "ArrowUp", modifiers: 5 },
    {
      type: "key",
      source: 3,
      sequence: 5,
      key: "a",
      modifiers: 0,
      text: "a",
    },
    { type: "pointer", source: 6, sequence: 7, x: -12, y: 300, buttons: 2 },
    { type: "timer", source: 8, sequence: 9, ticks: 0xfeedbeef },
    {
      type: "device",
      source: 10,
      sequence: 11,
      status: 4,
      bytes: Uint8Array.of(8, 9),
    },
    { type: "data", source: 12, sequence: 13, bytes: Uint8Array.of(10) },
    {
      type: "raw",
      source: 14,
      sequence: 15,
      bytes: Uint8Array.of(0x1b, 0x5b, 0x41),
    },
    { type: "error", source: 16, sequence: 17, code: 3, message: "offline" },
  ] as const;
  for (const event of events) {
    assert.deepEqual(decodeEffectEvent(encodeEffectEvent(event)), event);
  }
});

Deno.test("the synchronous client records commands, queries and typed input", () => {
  const provider = new RecordingEffectProvider();
  const client = new EffectClient(new ProviderTransport(provider));
  client.sendText("hello");
  client.sendControl(9, Uint8Array.of(0x1b, 0x5b, 0x32, 0x4a));
  provider.setQueryReply(9, Uint8Array.of(0x10), Uint8Array.of(0x42));
  assert.deepEqual(client.query(9, Uint8Array.of(0x10)), Uint8Array.of(0x42));
  provider.queueEvent({
    type: "key",
    source: 1,
    sequence: 20,
    key: "ArrowUp",
    modifiers: 1,
  });
  provider.queueEvent({
    type: "raw",
    source: 1,
    sequence: 21,
    bytes: Uint8Array.of(0x1b, 0x5b, 0x41),
  });
  assert.deepEqual(client.readEvent(), {
    type: "key",
    source: 1,
    sequence: 20,
    key: "ArrowUp",
    modifiers: 1,
  });
  assert.throws(
    () => client.readEvent(),
    (error) => error instanceof EffectProtocolError && error.code === "device",
  );
  assert.deepEqual(client.readEvent("raw"), {
    type: "raw",
    source: 1,
    sequence: 21,
    bytes: Uint8Array.of(0x1b, 0x5b, 0x41),
  });
  assert.equal(client.readEvent(), null);
  assert.deepEqual(provider.textWrites, [new TextEncoder().encode("hello")]);
  assert.deepEqual(provider.controls, [{
    capability: 9,
    bytes: Uint8Array.of(0x1b, 0x5b, 0x32, 0x4a),
  }]);
});

Deno.test("event admission reserves the response status byte", () => {
  const provider = new RecordingEffectProvider();
  const client = new EffectClient(new ProviderTransport(provider));
  provider.queueEvent({
    type: "text",
    source: 1,
    sequence: 1,
    text: "a".repeat(1016),
  });
  assert.equal(client.readEvent()?.type, "text");
  assert.throws(
    () =>
      provider.queueEvent({
        type: "text",
        source: 1,
        sequence: 2,
        text: "a".repeat(1017),
      }),
    (error) =>
      error instanceof EffectProtocolError && error.code === "capacity",
  );
  assert.equal(client.readEvent(), null);
});

Deno.test("unsupported framed commands return checked provider errors", () => {
  const provider = new RecordingEffectProvider();
  const transport = new ProviderTransport(provider);
  const response = decodeEffectResponse(
    decodeEffectFrame(
      transport.transact(encodeEffectFrame({
        kind: "request",
        opcode: 0xff,
        correlation: 42,
        payload: new Uint8Array(0),
      })),
    ),
  );
  assert.deepEqual(response, {
    status: "error",
    code: "unsupported",
    message: "Unsupported effect command opcode 255",
  });
  assert.equal(EffectCommandOpcode.readEvent, 3);
});
