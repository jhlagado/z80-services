import test from "node:test";
import assert from "node:assert/strict";
import vectors from "../conformance/vectors/byte-gateway-v0.json" with {
  type: "json",
};
import { MemoryByteGateway } from "./byte-gateway.ts";
import { BYTE_GATEWAY_PROFILE } from "./contract.ts";

function reset(gateway: MemoryByteGateway) {
  gateway.reset();
  return { status: 0 };
}

test("memory byte gateway passes the language-neutral vectors", () => {
  assert.equal(vectors.profile, "byteGateway");
  assert.equal(vectors.version, BYTE_GATEWAY_PROFILE.version);
  for (const vector of vectors.vectors) {
    const gateway = new MemoryByteGateway(vector.initial);
    for (const [index, step] of vector.steps.entries()) {
      const result =
        step.operation === "reset"
          ? reset(gateway)
          : gateway.dispatch(step.operation, step.arguments);
      assert.deepEqual(
        result,
        step.result,
        `${vector.name} step ${index} result`,
      );
      assert.deepEqual(
        gateway.snapshot(),
        step.state,
        `${vector.name} step ${index} state`,
      );
    }
  }
});

test("numeric operation identities dispatch through the same contract", () => {
  const gateway = new MemoryByteGateway({ input: [0x41] });
  assert.deepEqual(
    gateway.dispatch(BYTE_GATEWAY_PROFILE.operations.readInputByte),
    { status: 0, value: 0x41 },
  );
});

test("invalid initial state is rejected before a run begins", () => {
  assert.throws(() => new MemoryByteGateway({ input: [0x100] }), /non-byte/);
  assert.throws(
    () =>
      new MemoryByteGateway({
        storageOutput: [1, 2],
        storageOutputCapacity: 1,
      }),
    /exceeds its capacity/,
  );
});
