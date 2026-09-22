import assert from "node:assert/strict";
import {
  decodeEffectCommand,
  decodeEffectFrame,
  decodeEffectResponse,
  DEFAULT_EFFECT_LIMITS,
  EffectClient,
  EffectCommandOpcode,
  EffectPendingError,
  EffectProtocolError,
  type EffectResponse,
  encodeEffectCommand,
  encodeEffectResponse,
  ProviderTransport,
  RecordingEffectProvider,
} from "./p2-transport.ts";
import {
  CooperativeEffectScheduler,
  DeferredEffectProvider,
} from "./p2-scheduler.ts";

Deno.test("pending responses and poll commands round-trip on the wire", () => {
  const pollFrame = decodeEffectFrame(
    encodeEffectCommand({ type: "poll", task: 42 }, 8),
  );
  assert.equal(pollFrame.opcode, EffectCommandOpcode.poll);
  assert.deepEqual(decodeEffectCommand(pollFrame), {
    type: "poll",
    task: 42,
  });

  const pendingFrame = decodeEffectFrame(
    encodeEffectResponse(
      { status: "pending", task: 42 },
      8,
      EffectCommandOpcode.query,
    ),
  );
  assert.deepEqual(decodeEffectResponse(pendingFrame), {
    status: "pending",
    task: 42,
  });
  assert.throws(
    () => encodeEffectCommand({ type: "poll", task: 0 }, 9),
    RangeError,
  );
  assert.throws(
    () =>
      encodeEffectResponse(
        { status: "pending", task: 0 },
        9,
        EffectCommandOpcode.query,
      ),
    RangeError,
  );
});

Deno.test("deferred provider releases a reply after deterministic polls", () => {
  const inner = new RecordingEffectProvider();
  inner.setQueryReply(7, Uint8Array.of(1), Uint8Array.of(0x41));
  const provider = new DeferredEffectProvider(
    inner,
    DEFAULT_EFFECT_LIMITS,
    { polls: 1 },
  );
  const client = new EffectClient(new ProviderTransport(provider));

  const first = client.request({
    type: "query",
    capability: 7,
    bytes: Uint8Array.of(1),
  });
  assert.deepEqual(first, { status: "pending", task: 1 });
  assert.deepEqual(client.poll(1), { status: "pending", task: 1 });
  assert.deepEqual(client.poll(1), {
    status: "ok",
    bytes: Uint8Array.of(0x41),
  });
});

Deno.test("the synchronous convenience methods identify pending input", () => {
  const inner = new RecordingEffectProvider();
  inner.queueEvent({
    type: "key",
    source: 1,
    sequence: 1,
    key: "ArrowUp",
    modifiers: 0,
  });
  const provider = new DeferredEffectProvider(
    inner,
    DEFAULT_EFFECT_LIMITS,
    { polls: 0 },
  );
  const client = new EffectClient(new ProviderTransport(provider));
  assert.throws(
    () => client.readEvent(),
    (error) => error instanceof EffectPendingError && error.task === 1,
  );
});

interface TaskState {
  readonly name: string;
  readonly request: number;
  readonly reply?: number;
  readonly turns: number;
}

Deno.test("round-robin scheduler interleaves waiting tasks", () => {
  const inner = new RecordingEffectProvider();
  inner.setQueryReply(9, Uint8Array.of(0x10), Uint8Array.of(0x41));
  inner.setQueryReply(9, Uint8Array.of(0x20), Uint8Array.of(0x42));
  const provider = new DeferredEffectProvider(
    inner,
    DEFAULT_EFFECT_LIMITS,
    { polls: 1 },
  );
  const client = new EffectClient(new ProviderTransport(provider));
  const order: string[] = [];
  const runner = (
    state: TaskState,
    response: EffectResponse | undefined,
  ) => {
    order.push(state.name);
    if (response === undefined) {
      return {
        type: "request" as const,
        state: { ...state, turns: state.turns + 1 },
        command: {
          type: "query" as const,
          capability: 9,
          bytes: Uint8Array.of(state.request),
        },
      };
    }
    if (response.status !== "ok") {
      throw new Error(`unexpected response: ${response.status}`);
    }
    return {
      type: "done" as const,
      state: {
        ...state,
        reply: response.bytes[0],
        turns: state.turns + 1,
      },
    };
  };
  const scheduler = new CooperativeEffectScheduler<TaskState>(client);
  assert.equal(
    scheduler.spawn({ name: "A", request: 0x10, turns: 0 }, runner),
    1,
  );
  assert.equal(
    scheduler.spawn({ name: "B", request: 0x20, turns: 0 }, runner),
    2,
  );

  assert.equal(scheduler.step(), true);
  assert.equal(scheduler.snapshot()[0]?.status, "waiting");
  assert.equal(scheduler.snapshot()[1]?.status, "ready");
  assert.equal(scheduler.step(), true);
  assert.deepEqual(
    scheduler.snapshot().map((task) => task.status),
    ["waiting", "waiting"],
  );

  const completed = scheduler.run();
  assert.deepEqual(order, ["A", "B", "A", "B"]);
  assert.deepEqual(
    completed.map((task) => ({
      id: task.id,
      status: task.status,
      reply: task.state.reply,
      turns: task.state.turns,
    })),
    [
      { id: 1, status: "done", reply: 0x41, turns: 2 },
      { id: 2, status: "done", reply: 0x42, turns: 2 },
    ],
  );
});

Deno.test("scheduler exposes failed tasks and enforces its limits", () => {
  const client = new EffectClient(
    new ProviderTransport(new RecordingEffectProvider()),
  );
  const scheduler = new CooperativeEffectScheduler<{ readonly value: number }>(
    client,
    { maxTasks: 1, maxSteps: 1 },
  );
  scheduler.spawn({ value: 0 }, () => {
    throw new Error("runner failed");
  });
  assert.throws(() => scheduler.step(), /runner failed/);
  const failed = scheduler.snapshot()[0];
  assert.equal(failed?.status, "failed");
  assert.equal((failed?.error as Error | undefined)?.message, "runner failed");

  assert.throws(
    () =>
      scheduler.spawn({ value: 1 }, () => ({
        type: "done" as const,
        state: { value: 1 },
      })),
    (error) =>
      error instanceof EffectProtocolError && error.code === "capacity",
  );

  const bounded = new CooperativeEffectScheduler<{ readonly value: number }>(
    client,
    { maxTasks: 1, maxSteps: 1 },
  );
  bounded.spawn({ value: 0 }, (state) => ({
    type: "yield" as const,
    state,
  }));
  assert.throws(
    () => bounded.run(),
    (error) =>
      error instanceof EffectProtocolError && error.code === "capacity",
  );
});

Deno.test("scheduler polls waiting work fairly beside a yielding task", () => {
  const inner = new RecordingEffectProvider();
  const provider = new DeferredEffectProvider(
    inner,
    DEFAULT_EFFECT_LIMITS,
    { polls: 0 },
  );
  const client = new EffectClient(new ProviderTransport(provider));
  const scheduler = new CooperativeEffectScheduler<{ readonly turns: number }>(
    client,
  );
  scheduler.spawn({ turns: 0 }, (state, response) => {
    if (response === undefined) {
      return {
        type: "request" as const,
        state,
        command: { type: "text" as const, bytes: new Uint8Array(0) },
      };
    }
    assert.equal(response.status, "ok");
    return { type: "done" as const, state };
  });
  scheduler.spawn({ turns: 0 }, (state) => ({
    type: "yield" as const,
    state: { turns: state.turns + 1 },
  }));

  for (let turn = 0; turn < 5; turn++) assert.equal(scheduler.step(), true);
  assert.equal(scheduler.snapshot()[0]?.status, "done");
  assert.equal(scheduler.snapshot()[1]?.status, "ready");
});
