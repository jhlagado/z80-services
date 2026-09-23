import { BYTE_GATEWAY_PROFILE, STATUS } from "./contract.ts";

export interface GatewayResult {
  readonly status: number;
  readonly value?: number;
}

export interface ByteGatewayState {
  readonly input?: readonly number[] | Uint8Array;
  readonly storageInput?: readonly number[] | Uint8Array;
  readonly storageOutput?: readonly number[] | Uint8Array;
  readonly outputCapacity?: number;
  readonly storageOutputCapacity?: number;
  readonly failInputReads?: boolean;
  readonly failOutputWrites?: boolean;
  readonly failStorageReads?: boolean;
  readonly failStorageRewind?: boolean;
  readonly failStorageWrites?: boolean;
  readonly failStorageSeek?: boolean;
}

export interface ByteGatewaySnapshot {
  readonly inputOffset: number;
  readonly output: readonly number[];
  readonly storageInputOffset: number;
  readonly storageOutputOffset: number;
  readonly storageOutput: readonly number[];
}

export interface ByteGateway {
  dispatch(
    operation: string | number,
    arguments_?: Readonly<Record<string, unknown>>,
  ): GatewayResult;
  reset(): void;
  snapshot(): ByteGatewaySnapshot;
}

const operationNames = new Map<number, string>(
  Object.entries(BYTE_GATEWAY_PROFILE.operations).map(([name, code]) => [
    code,
    name,
  ]),
);

function bytes(
  name: string,
  values: readonly number[] | Uint8Array | undefined,
): number[] {
  const result = [...(values ?? [])];
  if (
    result.some((value) =>
      !Number.isInteger(value) || value < 0 || value > 0xff
    )
  ) {
    throw new TypeError(`${name} contains a non-byte value`);
  }
  return result;
}

function capacity(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function byte(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 &&
      (value as number) <= 0xff
    ? value as number
    : undefined;
}

function word(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 &&
      (value as number) <= 0xffff
    ? value as number
    : undefined;
}

export class MemoryByteGateway implements ByteGateway {
  readonly #initialInput: number[];
  readonly #initialStorageInput: number[];
  readonly #initialStorageOutput: number[];
  readonly #outputCapacity: number;
  readonly #storageOutputCapacity: number;
  readonly #failInputReads: boolean;
  readonly #failOutputWrites: boolean;
  readonly #failStorageReads: boolean;
  readonly #failStorageRewind: boolean;
  readonly #failStorageWrites: boolean;
  readonly #failStorageSeek: boolean;
  readonly #output: number[] = [];
  readonly #storageOutput: number[] = [];
  #inputOffset = 0;
  #storageInputOffset = 0;
  #storageOutputOffset = 0;

  constructor(state: ByteGatewayState = {}) {
    this.#initialInput = bytes("input", state.input);
    this.#initialStorageInput = bytes("storage input", state.storageInput);
    this.#initialStorageOutput = bytes("storage output", state.storageOutput);
    this.#outputCapacity = capacity("output capacity", state.outputCapacity);
    this.#storageOutputCapacity = capacity(
      "storage output capacity",
      state.storageOutputCapacity,
    );
    if (this.#initialStorageOutput.length > this.#storageOutputCapacity) {
      throw new TypeError("initial storage output exceeds its capacity");
    }
    this.#failInputReads = state.failInputReads === true;
    this.#failOutputWrites = state.failOutputWrites === true;
    this.#failStorageReads = state.failStorageReads === true;
    this.#failStorageRewind = state.failStorageRewind === true;
    this.#failStorageWrites = state.failStorageWrites === true;
    this.#failStorageSeek = state.failStorageSeek === true;
    this.reset();
  }

  dispatch(
    operation: string | number,
    arguments_: Readonly<Record<string, unknown>> = {},
  ): GatewayResult {
    const name = typeof operation === "number"
      ? operationNames.get(operation)
      : operation;
    switch (name) {
      case "readInputByte":
        return this.readInputByte();
      case "writeOutputByte":
        return this.writeOutputByte(arguments_.value);
      case "readStorageByte":
        return this.readStorageByte();
      case "rewindStorageInput":
        return this.rewindStorageInput();
      case "writeStorageByte":
        return this.writeStorageByte(arguments_.value);
      case "seekStorageOutput":
        return this.seekStorageOutput(arguments_.offset);
      default:
        return { status: STATUS.invalid };
    }
  }

  reset(): void {
    this.#inputOffset = 0;
    this.#storageInputOffset = 0;
    this.#output.length = 0;
    this.#storageOutput.length = 0;
    this.#storageOutput.push(...this.#initialStorageOutput);
    this.#storageOutputOffset = this.#storageOutput.length;
  }

  snapshot(): ByteGatewaySnapshot {
    return {
      inputOffset: this.#inputOffset,
      output: [...this.#output],
      storageInputOffset: this.#storageInputOffset,
      storageOutputOffset: this.#storageOutputOffset,
      storageOutput: [...this.#storageOutput],
    };
  }

  private readInputByte(): GatewayResult {
    if (this.#failInputReads) return { status: STATUS.inputFailure };
    if (this.#inputOffset === this.#initialInput.length) {
      return { status: STATUS.endOfInput };
    }
    return {
      status: STATUS.success,
      value: this.#initialInput[this.#inputOffset++]!,
    };
  }

  private writeOutputByte(argument: unknown): GatewayResult {
    const value = byte(argument);
    if (value === undefined) return { status: STATUS.invalid };
    if (
      this.#failOutputWrites || this.#output.length === this.#outputCapacity
    ) {
      return { status: STATUS.outputFailure };
    }
    this.#output.push(value);
    return { status: STATUS.success };
  }

  private readStorageByte(): GatewayResult {
    if (this.#failStorageReads) return { status: STATUS.storageFailure };
    if (this.#storageInputOffset === this.#initialStorageInput.length) {
      return { status: STATUS.endOfInput };
    }
    return {
      status: STATUS.success,
      value: this.#initialStorageInput[this.#storageInputOffset++]!,
    };
  }

  private rewindStorageInput(): GatewayResult {
    if (this.#failStorageRewind) return { status: STATUS.storageFailure };
    this.#storageInputOffset = 0;
    return { status: STATUS.success };
  }

  private writeStorageByte(argument: unknown): GatewayResult {
    const value = byte(argument);
    if (value === undefined) return { status: STATUS.invalid };
    if (
      this.#failStorageWrites ||
      (this.#storageOutputOffset === this.#storageOutput.length &&
        this.#storageOutput.length === this.#storageOutputCapacity)
    ) {
      return { status: STATUS.storageFailure };
    }
    this.#storageOutput[this.#storageOutputOffset++] = value;
    return { status: STATUS.success };
  }

  private seekStorageOutput(argument: unknown): GatewayResult {
    const offset = word(argument);
    if (
      offset === undefined || this.#failStorageSeek ||
      offset > this.#storageOutput.length
    ) {
      return {
        status: offset === undefined ? STATUS.invalid : STATUS.storageFailure,
      };
    }
    this.#storageOutputOffset = offset;
    return { status: STATUS.success };
  }
}
