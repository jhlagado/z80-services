import assert from "node:assert/strict";
import projection from "../conformance/projections/nucleus-byte-gateway-v0.json" with {
  type: "json",
};
import { BYTE_GATEWAY_PROFILE, STATUS } from "./contract.ts";

Deno.test("Nucleus projects its six byte services onto the shared gateway", () => {
  assert.equal(projection.schema, "z80-services-projection-v1");
  assert.equal(projection.providerContract, "z80-services-v0");
  assert.equal(projection.profile, "byteGateway");
  assert.equal(projection.version, BYTE_GATEWAY_PROFILE.version);
  assert.deepEqual(
    projection.operations.map(({ consumer, provider, code }) => ({
      consumer,
      provider,
      code,
    })),
    Object.entries(BYTE_GATEWAY_PROFILE.operations).map(([name, code]) => ({
      consumer: name,
      provider: name,
      code,
    })),
  );
  assert.deepEqual(projection.statuses, {
    success: STATUS.success,
    endOfInput: STATUS.endOfInput,
    inputFailure: STATUS.inputFailure,
    outputFailure: STATUS.outputFailure,
    storageFailure: STATUS.storageFailure,
  });
  assert.deepEqual(projection.excludedConsumerVectors, [
    "success",
    "unhandledFailure",
    "trap",
    "farCall",
    "farJump",
  ]);
});
