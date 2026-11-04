/** Persisted domain types. All timestamps are ISO 8601 strings. */
export type Role = "viewer" | "member" | "admin" | "owner";
export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export interface Organization {
  id: string;
  name: string;
  githubOrganization: string;
  ownerUid: string;
  createdAt: string;
  isDemoData?: boolean;
}

/** organizations/{orgId}/members/{uid}: roles are scoped to one organization. */
export interface Membership {
  uid: string;
  organizationId: string;
  role: Role;
  email?: string;
  createdAt: string;
  isDemoData?: boolean;
}

export type ProjectStatus = "planning" | "active" | "on_hold" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "critical";

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  teamId: string | null;
  /** Repository names inside the organization's GitHub account, validated on write. */
  repositoryIds: string[];
  ownerUid: string | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export interface Task {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeUid: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";
export type IncidentStatus = "open" | "investigating" | "mitigated" | "resolved";
export interface Incident {
  id: string;
  organizationId: string;
  projectId: string | null;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
  relatedEvidenceIds: string[];
  investigationIds: string[];
  isDemoData?: boolean;
}

export interface EngineeringSnapshot {
  id: string;
  organizationId: string;
  repositoryId: string;
  capturedAt: string;
  issueCounts: { open: number; openBugs: number };
  pullRequestCounts: { open: number; stale: number };
  workflowSummary: { completedRuns: number; successRate: number | null; latestConclusion: string | null };
  activitySummary: { commitsInWindow: number; lastCommitAt: string | null };
  dataSource: "github" | "fixture";
  isDemoData: boolean;
}
