import assert from "node:assert/strict";
import {
  assembleResolvedAtomProject,
  materializeAtomGeneration,
  writeAtomD8,
} from "atom-z80";
import { createZ80Runtime } from "@jhlagado/debug80-runtime";
import { MemoryByteGateway } from "../reference/byte-gateway.ts";
import { createIoPortGateway } from "../reference/io-port-gateway.ts";
import proof from "../proofs/byte-gateway-v0.json" with { type: "json" };

const LOAD = 0x2000;
const STACK = 0xf000;
const RETURN = 0xffff;
const files = {
  contract: "native/include/z80-services-v0.asmi",
  client: "native/client/byte-gateway.asm",
  program: "native/test/byte-gateway-program.asm",
  memory: "native/providers/memory-byte-gateway.asm",
  io: "native/providers/io-port-byte-gateway.asm",
};

const read = (name) => Deno.readTextFile(name);

async function assemble(provider) {
  const [contract, client, implementation, program] = await Promise.all([
    read(files.contract),
    read(files.client),
    read(files[provider]),
    read(files.program),
  ]);
  const source = `ORG ${
    LOAD.toString(16)
  }H\n${contract}\n${client}\n${implementation}\n${program}`;
  const bytes = new TextEncoder().encode(source);
  const project = {
    parts: [{
      ordinal: 0,
      bank: 0,
      logicalIdentity: `${provider}-provider-proof.asm`,
      originalBytes: bytes,
      compilerBytes: bytes,
    }],
  };
  const result = await assembleResolvedAtomProject(project, {
    target: { start: 0, capacity: 0xffff },
    maxInstructions: 100_000_000,
    maxCycles: 1_000_000_000,
  }).catch((cause) => {
    const line = cause.diagnostic?.line;
    throw new Error(
      `${provider}-provider-proof.asm:${line ?? "?"}: ${cause.message} ${
        JSON.stringify(cause.diagnostic ?? {})
      }\n${line === undefined ? "" : source.split("\n")[line - 1]}`,
      { cause },
    );
  });
  const debugMap = writeAtomD8(project, result.generation);
  const symbols = Object.fromEntries(debugMap.symbols.flatMap((symbol) => {
    const value = symbol.address ?? symbol.value;
    return value === undefined ? [] : [[symbol.name.toUpperCase(), value]];
  }));
  const materialized = materializeAtomGeneration(result.generation, {
    base: 0,
  });
  return { memory: materialized.bytes, symbols };
}

function putWord(memory, address, value) {
  memory[address] = value & 0xff;
  memory[address + 1] = value >>> 8;
}

function initialiseCpu(runtime, symbols) {
  putWord(runtime.hardware.memory, STACK, RETURN);
  Object.assign(runtime.cpu, {
    a_prime: 0xa1,
    b_prime: 0xb2,
    c_prime: 0xc3,
    d_prime: 0xd4,
    e_prime: 0xe5,
    h_prime: 0xf6,
    l_prime: 0x17,
    ix: 0x4567,
    iy: 0x89ab,
    sp: STACK,
    pc: symbols.ZS_START,
  });
  runtime.cpu.flags_prime.byte = 0x95;
}

function run(runtime) {
  let instructions = 0;
  let cycles = 0;
  while (runtime.cpu.pc !== RETURN && instructions < 10_000) {
    cycles += runtime.step().cycles ?? 0;
    instructions += 1;
  }
  assert.equal(runtime.cpu.pc, RETURN, "consumer must return to its caller");
  return { instructions, cycles };
}

function invoke(runtime, entry) {
  putWord(runtime.hardware.memory, STACK, RETURN);
  runtime.cpu.sp = STACK;
  runtime.cpu.pc = entry;
  let instructions = 0;
  while (runtime.cpu.pc !== RETURN && instructions < 1_000) {
    runtime.step();
    instructions += 1;
  }
  assert.equal(runtime.cpu.pc, RETURN, "service must return to its caller");
  assert.equal(runtime.cpu.sp, STACK + 2);
}

function assertMachineContract(runtime, symbols) {
  assert.equal(runtime.cpu.sp, STACK + 2);
  assert.equal(runtime.cpu.ix, 0x4567);
  assert.equal(runtime.cpu.iy, 0x89ab);
  assert.deepEqual(
    [
      runtime.cpu.a_prime,
      runtime.cpu.b_prime,
      runtime.cpu.c_prime,
      runtime.cpu.d_prime,
      runtime.cpu.e_prime,
      runtime.cpu.h_prime,
      runtime.cpu.l_prime,
      runtime.cpu.flags_prime.byte,
    ],
    [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x17, 0x95],
  );
  assert.equal(runtime.hardware.memory[symbols.ZS_RES], 0);
}

Deno.test("portable client is an 18-byte six-entry JP vector", async () => {
  const built = await assemble("memory");
  assert.equal(
    built.symbols.ZS_VEND - built.symbols.ZSRDIN,
    proof.clientBytes,
  );
  assert.deepEqual(
    [
      built.symbols.ZSWROUT,
      built.symbols.ZSRDST,
      built.symbols.ZSRWST,
      built.symbols.ZSWRST,
      built.symbols.ZSSKST,
      built.symbols.ZS_VEND,
    ],
    [3, 6, 9, 12, 15, 18].map((offset) => built.symbols.ZSRDIN + offset),
  );
});

Deno.test("unchanged native consumer passes against the memory provider", async () => {
  const built = await assemble("memory");
  const memory = new Uint8Array(0x10000);
  memory.set(built.memory);
  memory[built.symbols.ZS_ILEN] = 1;
  memory[built.symbols.ZS_IBUF] = 0x41;
  memory[built.symbols.ZS_OCAP] = 16;
  memory[built.symbols.ZS_SILEN] = 1;
  memory[built.symbols.ZS_SIBUF] = 0x51;
  memory[built.symbols.ZS_SOPOS] = 1;
  memory[built.symbols.ZS_SOLEN] = 1;
  memory[built.symbols.ZS_SOCAP] = 16;
  memory[built.symbols.ZS_SOBUF] = 0x10;
  const runtime = createZ80Runtime({ memory, startAddress: LOAD }, LOAD);
  initialiseCpu(runtime, built.symbols);
  const execution = run(runtime);
  assertMachineContract(runtime, built.symbols);
  assert.deepEqual(
    {
      codeBytes: built.symbols.ZS_PCEND - built.symbols.ZP_RDIN,
      workspaceBytes: built.symbols.ZS_PEND - built.symbols.ZS_PCEND,
      integrationInstructions: execution.instructions,
      integrationCycles: execution.cycles,
    },
    proof.providers.memory,
  );
  assert.equal(
    built.symbols.ZS_END - built.symbols.ZS_RES,
    proof.testProgramBytes,
  );
  const finalMemory = runtime.hardware.memory;
  assert.equal(finalMemory[built.symbols.ZS_IPOS], 1);
  assert.equal(finalMemory[built.symbols.ZS_OLEN], 1);
  assert.equal(finalMemory[built.symbols.ZS_OBUF], 0x41);
  assert.equal(finalMemory[built.symbols.ZS_SIPOS], 1);
  assert.equal(finalMemory[built.symbols.ZS_SOPOS], 1);
  assert.equal(finalMemory[built.symbols.ZS_SOLEN], 2);
  assert.deepEqual(
    [...finalMemory.slice(built.symbols.ZS_SOBUF, built.symbols.ZS_SOBUF + 2)],
    [0x5a, 0x66],
  );
  assert.ok(execution.instructions > 0);
  assert.ok(execution.cycles > 0);
});

Deno.test("unchanged native consumer passes against the I/O-port provider", async () => {
  const built = await assemble("io");
  const gateway = new MemoryByteGateway({
    input: [0x41],
    storageInput: [0x51],
    storageOutput: [0x10],
    storageOutputCapacity: 16,
  });
  const io = createIoPortGateway(gateway);
  const memory = new Uint8Array(0x10000);
  memory.set(built.memory);
  const runtime = createZ80Runtime(
    { memory, startAddress: LOAD },
    LOAD,
    { read: io.read, write: io.write },
  );
  initialiseCpu(runtime, built.symbols);
  const execution = run(runtime);
  assertMachineContract(runtime, built.symbols);
  assert.deepEqual(
    {
      codeBytes: built.symbols.ZS_PCEND - built.symbols.ZP_RDIN,
      workspaceBytes: built.symbols.ZS_PEND - built.symbols.ZS_PCEND,
      integrationInstructions: execution.instructions,
      integrationCycles: execution.cycles,
    },
    proof.providers.io,
  );
  assert.equal(
    built.symbols.ZS_END - built.symbols.ZS_RES,
    proof.testProgramBytes,
  );
  assert.deepEqual(gateway.snapshot(), {
    inputOffset: 1,
    output: [0x41],
    storageInputOffset: 1,
    storageOutputOffset: 1,
    storageOutput: [0x5a, 0x66],
  });
  assert.ok(execution.instructions > 0);
  assert.ok(execution.cycles > 0);
});

Deno.test("native memory-provider failures are atomic", async () => {
  const built = await assemble("memory");
  const memory = new Uint8Array(0x10000);
  memory.set(built.memory);
  memory[built.symbols.ZS_FAIL] = 0x3f;
  memory[built.symbols.ZS_IPOS] = 1;
  memory[built.symbols.ZS_ILEN] = 2;
  memory[built.symbols.ZS_OLEN] = 1;
  memory[built.symbols.ZS_OCAP] = 2;
  memory[built.symbols.ZS_OBUF] = 0x44;
  memory[built.symbols.ZS_SIPOS] = 1;
  memory[built.symbols.ZS_SILEN] = 2;
  memory[built.symbols.ZS_SOPOS] = 1;
  memory[built.symbols.ZS_SOLEN] = 2;
  memory[built.symbols.ZS_SOCAP] = 3;
  memory[built.symbols.ZS_SOBUF] = 0x11;
  memory[built.symbols.ZS_SOBUF + 1] = 0x22;
  const runtime = createZ80Runtime({ memory, startAddress: LOAD }, LOAD);
  const stateStart = built.symbols.ZS_IPOS;
  const before = runtime.hardware.memory.slice(
    stateStart,
    built.symbols.ZS_MEND,
  );
  const cases = [
    [built.symbols.ZSRDIN, 2, undefined],
    [built.symbols.ZSWROUT, 3, { a: 0x55 }],
    [built.symbols.ZSRDST, 4, undefined],
    [built.symbols.ZSRWST, 4, undefined],
    [built.symbols.ZSWRST, 4, { a: 0x66 }],
    [built.symbols.ZSSKST, 4, { h: 0, l: 1 }],
  ];
  for (const [entry, status, registers] of cases) {
    Object.assign(runtime.cpu, registers ?? {});
    invoke(runtime, entry);
    assert.equal(runtime.cpu.flags.C, 1);
    assert.equal(runtime.cpu.a, status);
  }
  assert.deepEqual(
    runtime.hardware.memory.slice(stateStart, built.symbols.ZS_MEND),
    before,
  );
});
