const TDD_WORKFLOW = "matt-tdd";

export async function authorizeWorkflowDispatch(workflowName, signal, ctx) {
  if (workflowName !== TDD_WORKFLOW) return false;
  if (!ctx.hasUI) {
    throw new Error("Workflow 'matt-tdd' requires explicit user authorization in TUI or RPC mode; no workflow was queued");
  }

  const confirmed = await ctx.ui.confirm(
    "Authorize matt-tdd?",
    "Only continue if you explicitly chose matt-implement for one verified ready ticket or approved direct slice. Cancel to publish a spec, split tickets, or pause instead.",
    signal ? { signal } : undefined,
  );
  signal?.throwIfAborted();
  if (!confirmed) {
    throw new Error("Workflow 'matt-tdd' was not authorized by the user; no workflow was queued");
  }
  return true;
}
