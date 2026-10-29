import { buildDispatchRequest as build, prepareDispatchRequest } from "../../lib/dispatcher-core.mjs";

export function buildDispatchRequest(registry, workflow, task, cwd, laneTasks, evidence, recovery) {
  return build(prepareDispatchRequest(registry, workflow, task, cwd, laneTasks), evidence, recovery);
}
