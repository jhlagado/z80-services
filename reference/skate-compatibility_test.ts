import assert from "node:assert/strict";
import projection from "../conformance/projections/skate-byte-gateway-v0.json" with {
  type: "json",
};
import { BYTE_GATEWAY_PROFILE, STATUS } from "./contract.ts";

Deno.test("Skate console operations project onto the shared byte gateway", () => {
  assert.equal(projection.schema, "z80-services-projection-v1");
  assert.equal(projection.consumer, "skate");
  assert.equal(projection.consumerContract, "skate-cpm-console-v0");
  assert.equal(projection.providerContract, "z80-services-v0");
  assert.equal(projection.profile, "byteGateway");
  assert.equal(projection.version, BYTE_GATEWAY_PROFILE.version);
  assert.deepEqual(projection.operations, [
    {
      consumer: "read-char",
      provider: "readInputByte",
      code: BYTE_GATEWAY_PROFILE.operations.readInputByte,
      result: "byte-or-eof",
    },
    {
      consumer: "write-char",
      provider: "writeOutputByte",
      code: BYTE_GATEWAY_PROFILE.operations.writeOutputByte,
      result: "status",
    },
  ]);
  assert.deepEqual(projection.statuses, {
    success: STATUS.success,
    endOfInput: STATUS.endOfInput,
    inputFailure: STATUS.inputFailure,
    outputFailure: STATUS.outputFailure,
    storageFailure: STATUS.storageFailure,
  });
  assert.deepEqual(projection.policies, {
    controlZ: "language-eof",
    echo: "consumer-adapter",
    lineEditing: "consumer-adapter",
    translateCrLf: "consumer-adapter",
  });
});
