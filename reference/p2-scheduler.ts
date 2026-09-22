/** Cooperative pending-effect provider and round-robin task scheduler. */
import {
  decodeEffectCommand,
  decodeEffectFrame,
  decodeEffectResponse,
  DEFAULT_EFFECT_LIMITS,
  EffectClient,
  type EffectCommand,
  type EffectFrame,
  type EffectLimits,
  EffectProtocolError,
  type EffectProvider,
  type EffectResponse,
  encodeEffectResponse,
} from "./p2-transport.ts";

export interface DeferredEffectOptions {
  /** Number of polls that return pending before the stored reply is released. */
  readonly polls?: number;
  /** Maximum unfinished provider tasks. */
  readonly maxTasks?: number;
}

/**
 * Deterministic provider adapter that turns a synchronous provider reply into
 * a pending task. It is useful for exercising scheduler behavior without
 * requiring an interrupt, clock or background thread.
 */
export class DeferredEffectProvider implements EffectProvider {
  private readonly polls: number;
  private readonly maxTasks: number;
  private nextTask = 1;
  private readonly tasks = new Map<number, {
    remaining: number;
    response: EffectResponse;
  }>();

  constructor(
    private readonly inner: EffectProvider,
    private readonly limits: EffectLimits = DEFAULT_EFFECT_LIMITS,
    options: DeferredEffectOptions = {},
  ) {
    this.polls = options.polls ?? 1;
    this.maxTasks = options.maxTasks ?? 64;
    if (
      !Number.isInteger(this.polls) || this.polls < 0 || this.polls > 0xffff
    ) {
      throw new RangeError("Deferred effect polls must be 0..65535");
    }
    if (
      !Number.isInteger(this.maxTasks) || this.maxTasks < 1 ||
      this.maxTasks > 0xffff
    ) {
      throw new RangeError("Deferred effect maxTasks must be 1..65535");
    }
  }

  handle(request: EffectFrame): EffectFrame {
    try {
      const command = decodeEffectCommand(request);
      if (command.type === "poll") return this.poll(request, command.task);
      if (this.tasks.size >= this.maxTasks) {
        return this.response(request, {
          status: "error",
          code: "capacity",
          message: "Deferred effect task table is full",
        });
      }
      const innerResponse = decodeEffectResponse(this.inner.handle(request));
      if (innerResponse.status === "pending") {
        return this.response(request, {
          status: "error",
          code: "unsupported",
          message: "Nested pending effects are not supported",
        });
      }
      const task = this.allocateTask();
      this.tasks.set(task, { remaining: this.polls, response: innerResponse });
      return this.response(request, { status: "pending", task });
    } catch (error) {
      const protocol = error instanceof EffectProtocolError
        ? error
        : new EffectProtocolError("malformed", String(error));
      return this.response(request, {
        status: "error",
        code: protocol.code,
        message: protocol.message,
      });
    }
  }

  private poll(request: EffectFrame, task: number): EffectFrame {
    const pending = this.tasks.get(task);
    if (pending === undefined) {
      return this.response(request, {
        status: "error",
        code: "device",
        message: `Unknown deferred effect task ${task}`,
      });
    }
    if (pending.remaining > 0) {
      pending.remaining--;
      return this.response(request, { status: "pending", task });
    }
    this.tasks.delete(task);
    return this.response(request, pending.response);
  }

  private allocateTask(): number {
    for (let attempt = 0; attempt < 0xffff; attempt++) {
      const task = this.nextTask;
      this.nextTask = this.nextTask === 0xffff ? 1 : this.nextTask + 1;
      if (!this.tasks.has(task)) return task;
    }
    throw new EffectProtocolError(
      "capacity",
      "Deferred effect task IDs exhausted",
    );
  }

  private response(
    request: EffectFrame,
    response: EffectResponse,
  ): EffectFrame {
    return decodeEffectFrame(
      encodeEffectResponse(
        response,
        request.correlation,
        request.opcode,
        this.limits,
      ),
      this.limits,
    );
  }
}

export interface EffectSchedulerLimits {
  readonly maxTasks: number;
  readonly maxSteps: number;
}

export const DEFAULT_EFFECT_SCHEDULER_LIMITS: Readonly<EffectSchedulerLimits> =
  Object.freeze({ maxTasks: 64, maxSteps: 65535 });

export type EffectTaskStatus = "ready" | "waiting" | "done" | "failed";

export type EffectTaskAction<State> =
  | {
    readonly type: "request";
    readonly state: State;
    readonly command: EffectCommand;
  }
  | { readonly type: "yield"; readonly state: State }
  | { readonly type: "done"; readonly state: State };

export type EffectTaskRunner<State> = (
  state: State,
  response: EffectResponse | undefined,
) => EffectTaskAction<State>;

export interface EffectTaskSnapshot<State> {
  readonly id: number;
  readonly status: EffectTaskStatus;
  readonly state: State;
  readonly waitingOn?: number;
  readonly error?: unknown;
}

interface Task<State> {
  readonly id: number;
  readonly runner: EffectTaskRunner<State>;
  state: State;
  status: EffectTaskStatus;
  waitingOn?: number;
  response?: EffectResponse;
  error?: unknown;
}

function validateSchedulerLimits(
  limits: EffectSchedulerLimits,
): Readonly<EffectSchedulerLimits> {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
      throw new RangeError(`Invalid effect scheduler ${name} limit`);
    }
  }
  return Object.freeze({ ...limits });
}

/** Round-robin scheduler for saved Scheme/harness task state. */
export class CooperativeEffectScheduler<State> {
  private readonly limits: Readonly<EffectSchedulerLimits>;
  private nextTask = 1;
  private readonly tasks = new Map<number, Task<State>>();
  private readonly ready: number[] = [];
  private readonly waiting: number[] = [];
  private preferWaiting = false;

  constructor(
    private readonly client: EffectClient,
    limits: EffectSchedulerLimits = DEFAULT_EFFECT_SCHEDULER_LIMITS,
  ) {
    this.limits = validateSchedulerLimits(limits);
  }

  spawn(state: State, runner: EffectTaskRunner<State>): number {
    if (this.tasks.size >= this.limits.maxTasks) {
      throw new EffectProtocolError("capacity", "Effect task table is full");
    }
    const id = this.allocateTask();
    this.tasks.set(id, { id, runner, state, status: "ready" });
    this.ready.push(id);
    return id;
  }

  /** Execute one runnable task turn or one poll turn. */
  step(): boolean {
    const bothQueues = this.ready.length > 0 && this.waiting.length > 0;
    if (bothQueues && this.preferWaiting) {
      const waitingId = this.waiting.shift()!;
      this.preferWaiting = false;
      const task = this.task(waitingId);
      this.pollWaiting(task);
      return true;
    }
    const readyId = this.ready.shift();
    if (readyId !== undefined) {
      if (bothQueues) this.preferWaiting = true;
      const task = this.task(readyId);
      this.runReady(task);
      return true;
    }
    const waitingId = this.waiting.shift();
    if (waitingId === undefined) return false;
    const task = this.task(waitingId);
    this.pollWaiting(task);
    return true;
  }

  run(maxSteps = this.limits.maxSteps): readonly EffectTaskSnapshot<State>[] {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 0xffff) {
      throw new RangeError("Effect scheduler maxSteps must be 1..65535");
    }
    for (let step = 0; step < maxSteps && !this.complete(); step++) {
      if (!this.step()) {
        throw new EffectProtocolError(
          "device",
          "Effect scheduler has no runnable task",
        );
      }
    }
    if (!this.complete()) {
      throw new EffectProtocolError(
        "capacity",
        `Effect scheduler exceeded ${maxSteps} steps`,
      );
    }
    return this.snapshot();
  }

  snapshot(): readonly EffectTaskSnapshot<State>[] {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      status: task.status,
      state: task.state,
      ...(task.waitingOn === undefined ? {} : { waitingOn: task.waitingOn }),
      ...(task.error === undefined ? {} : { error: task.error }),
    }));
  }

  private runReady(task: Task<State>): void {
    task.status = "ready";
    const response = task.response;
    task.response = undefined;
    try {
      const action = task.runner(task.state, response);
      task.state = action.state;
      if (action.type === "done") {
        task.status = "done";
        return;
      }
      if (action.type === "yield") {
        this.ready.push(task.id);
        return;
      }
      const result = this.client.request(action.command);
      this.routeResponse(task, result);
    } catch (error) {
      task.status = "failed";
      task.error = error;
      throw error;
    }
  }

  private pollWaiting(task: Task<State>): void {
    if (task.waitingOn === undefined) {
      throw new EffectProtocolError(
        "malformed",
        "Waiting task has no provider task ID",
      );
    }
    try {
      const result = this.client.poll(task.waitingOn);
      this.routeResponse(task, result);
    } catch (error) {
      task.status = "failed";
      task.error = error;
      throw error;
    }
  }

  private routeResponse(task: Task<State>, response: EffectResponse): void {
    if (response.status === "pending") {
      task.status = "waiting";
      task.waitingOn = response.task;
      this.waiting.push(task.id);
      return;
    }
    task.status = "ready";
    task.waitingOn = undefined;
    task.response = response;
    this.ready.push(task.id);
  }

  private complete(): boolean {
    return [...this.tasks.values()].every((task) => task.status === "done");
  }

  private task(id: number): Task<State> {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new EffectProtocolError(
        "malformed",
        `Unknown scheduler task ${id}`,
      );
    }
    return task;
  }

  private allocateTask(): number {
    for (let attempt = 0; attempt < 0xffff; attempt++) {
      const id = this.nextTask;
      this.nextTask = this.nextTask === 0xffff ? 1 : this.nextTask + 1;
      if (!this.tasks.has(id)) return id;
    }
    throw new EffectProtocolError("capacity", "Effect task IDs exhausted");
  }
}
