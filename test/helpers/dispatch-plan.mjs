import { buildDispatchRequest as build, prepareDispatchRequest } from "../../lib/dispatcher-core.mjs";

export function buildDispatchRequest(registry, workflow, task, cwd, options = {}) {
  const { laneTasks, lanes, resumeRunId, hostControls } = options;
  return build(
    prepareDispatchRequest(registry, workflow, task, cwd, { laneTasks, lanes }),
    { resumeRunId, hostControls },
  );
}
