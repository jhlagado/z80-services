import assert from "node:assert/strict";
import { MemoryByteGateway } from "./byte-gateway.ts";
import { BYTE_GATEWAY_PROFILE, STATUS } from "./contract.ts";
import { BYTE_GATEWAY_PORT, createIoPortGateway } from "./io-port-gateway.ts";

Deno.test("I/O-port gateway carries all byte-gateway argument shapes", () => {
  const gateway = new MemoryByteGateway({
    input: [0x41],
    storageInput: [0x51],
    storageOutput: [1, 2],
    storageOutputCapacity: 3,
  });
  const io = createIoPortGateway(gateway);
  const operation = BYTE_GATEWAY_PROFILE.operations;

  io.write(BYTE_GATEWAY_PORT.operation, operation.readInputByte);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.success);
  assert.equal(io.read(BYTE_GATEWAY_PORT.result), 0x41);

  io.write(BYTE_GATEWAY_PORT.operation, operation.writeOutputByte);
  io.write(BYTE_GATEWAY_PORT.value, 0x55);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.success);

  io.write(BYTE_GATEWAY_PORT.operation, operation.seekStorageOutput);
  io.write(BYTE_GATEWAY_PORT.value, 1);
  io.write(BYTE_GATEWAY_PORT.valueHigh, 0);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.success);

  io.write(BYTE_GATEWAY_PORT.operation, operation.writeStorageByte);
  io.write(BYTE_GATEWAY_PORT.value, 0x99);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.success);
  assert.deepEqual(gateway.snapshot(), {
    inputOffset: 1,
    output: [0x55],
    storageInputOffset: 0,
    storageOutputOffset: 2,
    storageOutput: [1, 0x99],
  });
});

Deno.test("I/O-port gateway rejects absent and unknown operations atomically", () => {
  const gateway = new MemoryByteGateway({ input: [0x41] });
  const io = createIoPortGateway(gateway);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.invalid);
  io.write(BYTE_GATEWAY_PORT.operation, 0xff);
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.invalid);
  assert.deepEqual(gateway.snapshot().inputOffset, 0);
  io.reset();
  assert.equal(io.read(BYTE_GATEWAY_PORT.status), STATUS.invalid);
});
