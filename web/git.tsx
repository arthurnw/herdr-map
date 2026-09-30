// Branch, changes, and PR badge for a workspace header and the preview.
import { Check, CircleSmall, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, X } from "lucide-react";
import { checkText, type CheckState, type PullRequest, type WorkspaceGit } from "../shared/git.ts";
import { stop } from "./organize.tsx";
import "./git.css";

function branchTitle(git: WorkspaceGit, worktree?: boolean): string {
  const lines = [git.branch ? `Branch ${git.branch}` : git.head ? `Detached at ${git.head}` : "No commits yet"];
  if (worktree) lines[0] += " in a linked worktree";
  lines.push(git.dirty ? `${git.dirty} changed file${git.dirty > 1 ? "s" : ""}` : "No uncommitted changes");
  if (git.upstream) lines.push(`${git.ahead ?? 0} ahead, ${git.behind ?? 0} behind ${git.upstream}`);
  lines.push(git.root);
  return lines.join("\n");
}

const REVIEW: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

function prTitle(pr: PullRequest): string {
  const lines = [`#${pr.number} ${pr.title}`, `${pr.draft && pr.state === "open" ? "Draft" : pr.state[0].toUpperCase() + pr.state.slice(1)}`];
  lines.push(`Checks: ${checkText(pr.checks)}`);
  if (pr.review) lines.push(`Review: ${REVIEW[pr.review] ?? pr.review.toLowerCase()}`);
  lines.push("Click to open on GitHub");
  return lines.join("\n");
}

const CI_ICON: Record<Exclude<CheckState, "none">, typeof Check> = { pass: Check, fail: X, pending: CircleSmall };
const CI_LABEL: Record<CheckState, string> = { pass: "checks passing", fail: "checks failing", pending: "checks pending", none: "no checks" };

function PrBadge({ pr }: { pr: PullRequest }) {
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : pr.draft ? GitPullRequestDraft : GitPullRequest;
  // Checks matter only while the PR is open.
  const ci = pr.state === "open" ? pr.checks.state : "none";
  const CiIcon = ci === "none" ? undefined : CI_ICON[ci];
  const status = pr.state === "open" ? (pr.draft ? "draft" : "open") : pr.state;
  return (
    <a
      className={`git-pr nodrag nopan pr-${status}`}
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={prTitle(pr)}
      aria-label={`Pull request #${pr.number}, ${status}, ${CI_LABEL[ci]}`}
      onClick={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
    >
      <Icon aria-hidden />#{pr.number}
      {CiIcon && <CiIcon className={`git-ci git-ci-${ci}`} aria-hidden />}
    </a>
  );
}

/**
 * Branch, change counts, and PR as separate flex items, so a cramped header shrinks the branch
 * name first and keeps the counts and PR whole. The name is left out when it's the workspace's label.
 */
export function GitBadge({ git, label, worktree }: { git?: WorkspaceGit; label?: string; worktree?: boolean }) {
  if (!git) return null;
  const BranchIcon = git.branch ? GitBranch : GitCommitHorizontal;
  const name = git.branch ?? git.head ?? "no commits";
  const title = branchTitle(git, worktree);
  const counts = git.dirty > 0 || !!git.ahead || !!git.behind;
  return (
    <>
      <span className="git-branch" title={title}>
        <BranchIcon aria-hidden />
        {name !== label && <span className="git-branch-name">{name}</span>}
      </span>
      {counts && (
        <span className="git-counts" title={title}>
          {git.dirty > 0 && <span className="git-dirty">●{git.dirty}</span>}
          {!!git.ahead && <span className="git-ahead">↑{git.ahead}</span>}
          {!!git.behind && <span className="git-behind">↓{git.behind}</span>}
        </span>
      )}
      {git.pr && <PrBadge pr={git.pr} />}
    </>
  );
}
