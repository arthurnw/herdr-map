import type { FleetAgent } from "../shared/model.ts";

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

export function agentAge(agent: FleetAgent, now: number): string {
  return `${formatAge(now - agent.since)}${agent.sinceApprox ? "+" : ""}`;
}
