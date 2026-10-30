import { randomUUID } from "node:crypto";

export const DISPATCH_EVENT = "pi-matt:dispatch-phase";

export function failureDetails(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.code !== undefined ? { code: error.code } : {}),
    ...(error?.signal !== undefined ? { signal: error.signal } : {}),
    ...(error?.killed !== undefined ? { killed: error.killed } : {}),
    ...(typeof error?.outputSha256 === "string" ? { outputSha256: error.outputSha256 } : {}),
    ...(error?.cause ? { cause: failureDetails(error.cause) } : {}),
  };
}

export async function withDeadline(work, { timeoutMs, signal, clock = globalThis } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort(signal.reason);
      reject(signal.reason ?? new Error("Dispatch cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = clock.setTimeout(() => {
      const error = Object.assign(new Error(`Phase timed out after ${timeoutMs}ms`), { code: "phase_timeout" });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }), interrupted]);
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Events contain identities and failures, never delegated tasks or credentials. */
export function createDispatchTrace({ id = randomUUID(), now = Date.now, emit = () => {}, persist = () => {} } = {}) {
  const events = [];
  return {
    id,
    events,
    record(phase, state, extra = {}) {
      const event = { type: "pi-x-matt.dispatch-phase", version: 1, dispatchId: id, phase, state, at: now(), ...extra };
      events.push(event);
      persist(event);
      emit(event);
      return event;
    },
    async step(phase, work) {
      const start = this.record(phase, "started");
      try {
        const result = await work();
        this.record(phase, "complete", { durationMs: now() - start.at });
        return result;
      } catch (error) {
        this.record(phase, error?.code === "phase_timeout" || error?.cause?.code === "phase_timeout" ? "timeout" : "failed", {
          durationMs: now() - start.at, error: failureDetails(error),
        });
        throw error;
      }
    },
  };
}

/** A lost spawn reply is unknown acceptance, never permission to repeat spawn. */
export function requestRpc(events, method, params, {
  requestId = randomUUID(), timeoutMs = 10_000, signal, clock = globalThis,
} = {}) {
  return withDeadline(phaseSignal => new Promise((resolve, reject) => {
    const unsubscribe = events.on(`subagents:rpc:v1:reply:${requestId}`, reply => {
      if (reply?.version !== 1 || reply.requestId !== requestId) return;
      cleanup();
      if (reply.success) resolve(reply.data);
      else reject(Object.assign(new Error(reply.error?.message ?? "pi-subagents RPC failed"), {
        code: reply.error?.code ?? "rpc_error",
      }));
    });
    const cleanup = () => { unsubscribe?.(); phaseSignal.removeEventListener("abort", cleanup); };
    phaseSignal.addEventListener("abort", cleanup, { once: true });
    try {
      events.emit("subagents:rpc:v1:request", {
        version: 1, requestId, method, params, source: { extension: "pi-x-matt" },
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  }), { timeoutMs, signal, clock }).catch(error => {
    if (error.code === "phase_timeout" || signal?.aborted) {
      throw Object.assign(new Error(
        `RPC ${method} acknowledgement timed out; acceptance unknown. Inspect rpc-spawn-${requestId}; do not redispatch.`,
        { cause: error },
      ), { code: "rpc_acceptance_unknown", requestId });
    }
    throw error;
  });
}
