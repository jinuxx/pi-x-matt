const TDD_WORKFLOW = "matt-tdd";
const IMPLEMENT_SKILL = "matt-implement";
const SKILL_COMMAND_PREFIX = "/skill:";
const USER_INPUT_SOURCES = new Set(["interactive", "rpc"]);

export function parseInvokedSkill(text) {
  if (typeof text !== "string" || !text.startsWith(SKILL_COMMAND_PREFIX)) return null;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(SKILL_COMMAND_PREFIX.length) : text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex);
  return name.trim() || null;
}

export function createDispatchAuthorization() {
  let userInvokedSkill = null;

  return {
    reset() {
      userInvokedSkill = null;
    },
    observeInput(text, source) {
      if (!USER_INPUT_SOURCES.has(source)) return userInvokedSkill;
      const skill = parseInvokedSkill(text);
      if (skill) userInvokedSkill = skill;
      return userInvokedSkill;
    },
    userInvokedImplement() {
      return userInvokedSkill === IMPLEMENT_SKILL;
    },
  };
}

export async function authorizeWorkflowDispatch(workflowName, signal, ctx, authorization) {
  if (workflowName !== TDD_WORKFLOW) return "not-required";
  if (authorization?.userInvokedImplement()) return "user-invoked-implement";
  if (!ctx.hasUI) {
    throw new Error(
      "Workflow 'matt-tdd' requires explicit user authorization outside an explicit /skill:matt-implement session; no workflow was queued",
    );
  }

  const confirmed = await ctx.ui.confirm(
    "Authorize matt-tdd?",
    "No explicit /skill:matt-implement invocation was seen in this session. Continue only if you already verified one ready ticket or approved a direct slice. Cancel to publish a spec, split tickets, or pause instead.",
    signal ? { signal } : undefined,
  );
  signal?.throwIfAborted();
  if (!confirmed) {
    throw new Error("Workflow 'matt-tdd' was not authorized by the user; no workflow was queued");
  }
  return "user-confirmed";
}
