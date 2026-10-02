// herdr's rules for agent names, checked before asking herdr to rename.

export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function isAgentName(name: unknown): name is string {
  return typeof name === "string" && AGENT_NAME.test(name);
}

/** Why `name` can't be used, or undefined when it can. `taken` holds the other live agents' names. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- also checks the name in a rename request
export function agentNameError(name: unknown, taken: Iterable<string>): string | undefined {
  if (!isAgentName(name)) {
    return "Use up to 32 lowercase letters, digits, - or _, starting with a letter.";
  }
  for (const other of taken) if (other === name) return `Another agent is already named ${name}.`;
  return undefined;
}
