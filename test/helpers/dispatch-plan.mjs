import { buildDispatchRequest as build, prepareDispatchRequest } from "../../lib/dispatcher-core.mjs";

export function buildDispatchRequest(registry, workflow, task, cwd, laneTasks, evidence, recovery, execution) {
  const required = execution?.writerRecovery || execution?.delivery === "verified" ? ["implement"] : undefined;
  return build(prepareDispatchRequest(registry, workflow, task, cwd, laneTasks,
    required), evidence, recovery, execution);
}
