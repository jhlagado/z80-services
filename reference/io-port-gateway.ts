import { BYTE_GATEWAY_PROFILE, STATUS } from "./contract.ts";
import type { ByteGateway, GatewayResult } from "./byte-gateway.ts";

export const BYTE_GATEWAY_PORT = Object.freeze({
  operation: 0xe0,
  value: 0xe1,
  status: 0xe2,
  result: 0xe3,
  valueHigh: 0xe4,
});

export interface IoPortGateway {
  read(port: number): number;
  write(port: number, value: number): void;
  reset(): void;
}

export function createIoPortGateway(gateway: ByteGateway): IoPortGateway {
  let operation: number | undefined;
  let value = 0;
  let valueHigh = 0;
  let result: GatewayResult = { status: STATUS.invalid };

  const dispatch = (): void => {
    if (operation === undefined) {
      result = { status: STATUS.invalid };
      return;
    }
    const operations = BYTE_GATEWAY_PROFILE.operations;
    if (
      operation === operations.writeOutputByte ||
      operation === operations.writeStorageByte
    ) {
      result = gateway.dispatch(operation, { value });
    } else if (operation === operations.seekStorageOutput) {
      result = gateway.dispatch(operation, {
        offset: value | (valueHigh << 8),
      });
    } else {
      result = gateway.dispatch(operation);
    }
    operation = undefined;
  };

  return {
    read(port: number): number {
      switch (port & 0xff) {
        case BYTE_GATEWAY_PORT.status:
          dispatch();
          return result.status;
        case BYTE_GATEWAY_PORT.result:
          return result.value ?? 0;
        default:
          return STATUS.invalid;
      }
    },
    write(port: number, next: number): void {
      switch (port & 0xff) {
        case BYTE_GATEWAY_PORT.operation:
          operation = next & 0xff;
          result = { status: STATUS.invalid };
          break;
        case BYTE_GATEWAY_PORT.value:
          value = next & 0xff;
          break;
        case BYTE_GATEWAY_PORT.valueHigh:
          valueHigh = next & 0xff;
          break;
      }
    },
    reset(): void {
      operation = undefined;
      value = 0;
      valueHigh = 0;
      result = { status: STATUS.invalid };
    },
  };
}
