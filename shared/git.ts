// A workspace's git state and pull request, as the git probe reports them.

export type CheckState = "pass" | "fail" | "pending" | "none";

export interface CheckSummary {
  state: CheckState;
  passed: number;
  failed: number;
  pending: number;
  /** Names of failing checks, up to a few. */
  failing?: string[];
  /** Names of pending checks, up to a few. */
  pendingNames?: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** GitHub's review decision, such as `APPROVED` or `CHANGES_REQUESTED`. */
  review?: string;
  checks: CheckSummary;
}

export interface WorkspaceGit {
  /** Top of the working tree. */
  root: string;
  /** Unset when HEAD is detached. */
  branch?: string;
  /** Short SHA of HEAD; unset before the first commit. */
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Entries in `git status`: changed, staged, and untracked paths. */
  dirty: number;
  pr?: PullRequest;
}

/** One line for a title attribute, like "3 passed, 1 failed (lint)". */
export function checkText(c: CheckSummary): string {
  if (c.state === "none") return "no checks";
  const parts = [c.passed && `${c.passed} passed`, c.failed && `${c.failed} failed`, c.pending && `${c.pending} pending`].filter(Boolean);
  return `${parts.join(", ")}${c.failing?.length ? ` (${c.failing.join(", ")})` : ""}`;
}

export type PrStatus = "open" | "draft" | "merged" | "closed";

/** A PR's state with drafts split out, as its badge shows it. */
export function prStatus(pr: PullRequest): PrStatus {
  return pr.state === "open" ? (pr.draft ? "draft" : "open") : pr.state;
}

/** Checks matter only while the PR is open. */
export function prChecks(pr: PullRequest): CheckState {
  return pr.state === "open" ? pr.checks.state : "none";
}
