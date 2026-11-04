export type HealthCategory = "delivery" | "ci" | "bugs" | "pullRequests" | "activity";
export type HealthStatus = "healthy" | "warning" | "critical" | "insufficient_data";

export interface SubScore {
  category: HealthCategory;
  /** 0–100, or null when the signal is unavailable (never 0 for "unknown"). */
  score: number | null;
  reason: string | null;           // why it is unavailable, or a short explanation
  inputs: Record<string, number | string | boolean | null>;
}

export interface CombinedScore {
  score: number | null;
  status: HealthStatus;
  /** Share of the configured total weight that had data (0–1). */
  coverage: number;
  /** Weights actually applied after renormalization. */
  appliedWeights: Partial<Record<HealthCategory, number>>;
  missingSignals: HealthCategory[];
}

export interface ProjectHealth extends CombinedScore {
  projectId: string;
  projectName: string;
  repositoryIds: string[];
  subScores: SubScore[];
  evidence: {
    stalePullRequests: Array<{ repositoryId: string; number: number; title: string; url: string; daysSinceUpdate: number }>;
    openBugs: Array<{ repositoryId: string; number: number; title: string; url: string; severity: string }>;
    recentFailedRuns: Array<{ repositoryId: string; id: number; name: string; url: string; conclusion: string; createdAt: string }>;
    overdueTasks: Array<{ taskId: string; title: string; dueDate: string; status: string }>;
    blockedTasks: Array<{ taskId: string; title: string }>;
  };
  repositoryErrors: Array<{ repositoryId: string; signal: string; code: string; message: string }>;
  isDemoData: boolean;
  dataSource: "github" | "fixture";
  computedAt: string;
}

export interface CompanyHealth extends CombinedScore {
  organizationId: string;
  categoryScores: Partial<Record<HealthCategory, number | null>>;
  projects: Array<Pick<ProjectHealth, "projectId" | "projectName" | "score" | "status" | "coverage" | "missingSignals">>;
  projectCounts: Record<HealthStatus, number>;
  excludedProjects: Array<{ projectId: string; reason: string }>;
  containsDemoData: boolean;
  dataSource: "github" | "fixture";
  computedAt: string;
}
