export type DataSource = "github" | "fixture";

export interface RepoSummary {
  id: string;            // repository name inside the organization (stable mapping key)
  fullName: string;
  owner: string;
  url: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}
export interface IssueItem {
  number: number; title: string; state: string; labels: string[];
  createdAt: string; updatedAt: string; closedAt: string | null; url: string; author: string | null; assignees: string[];
}
export interface PullRequestItem {
  number: number; title: string; draft: boolean; createdAt: string; updatedAt: string; url: string;
  author: string | null; requestedReviewers: number; baseBranch: string;
}
export interface CommitItem { sha: string; message: string; author: string | null; committedAt: string; url: string }
export interface WorkflowRunItem {
  id: number; name: string; event: string; status: string; conclusion: string | null;
  headBranch: string | null; createdAt: string; updatedAt: string; url: string; runAttempt: number;
}
export interface ReleaseItem { id: number; tagName: string; name: string | null; publishedAt: string | null; url: string; draft: boolean; prerelease: boolean }
export interface DeploymentItem {
  id: number; environment: string; ref: string; createdAt: string; url: string;
  latestStatus: { state: string; createdAt: string; environmentUrl: string | null; logUrl: string | null } | null;
}

/** Result of one signal fetch. Failures are captured per signal so one failure doesn't hide the others. */
export type Signal<T> = { ok: true; value: T; truncated: boolean } | { ok: false; error: string; code: string };

export interface RepositorySignals {
  repository: RepoSummary;
  source: DataSource;
  fetchedAt: string;
  issues: Signal<IssueItem[]> & { pullRequestsExcluded?: number };
  pullRequests: Signal<PullRequestItem[]>;
  commits: Signal<CommitItem[]>;
  workflowRuns: Signal<WorkflowRunItem[]>;
  releases: Signal<ReleaseItem[]>;
  deployments: Signal<DeploymentItem[]>;
}
