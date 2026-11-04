import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Store } from "../repositories/store.js";
import type { GitHubService } from "../integrations/github/github.service.js";
import type { Organization, Project, Task } from "../types/domain.js";
import { authorizeResource, requireOrgRole } from "./authorization.service.js";
import { validateRepositoryMapping } from "../domain/health/repository-mapping.js";
import { AppError, Errors, isAppError } from "../utils/errors.js";
import type { CreateProjectSchema, CreateTaskSchema, UpdateProjectSchema, UpdateTaskSchema } from "../schemas/project.schemas.js";

export class ProjectService {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubService,
    private readonly allowlist: string[],
    private readonly now: () => Date,
  ) {}

  /** Validates a mapping against the organization's real repositories. Refuses to save if GitHub can't be checked. */
  async validateMapping(org: Organization, repositoryIds: string[]) {
    if (!repositoryIds.length) return;
    let repos;
    try { repos = (await this.github.listRepositories(org.githubOrganization)).repositories; }
    catch (e) {
      throw new AppError("MAPPING_VALIDATION_UNAVAILABLE",
        "Repository mappings can't be validated because GitHub is unavailable. Try again later.", 503,
        undefined, isAppError(e) ? e.retryable : false);
    }
    const result = validateRepositoryMapping(repositoryIds, repos, this.allowlist);
    if (result.invalid.length) throw Errors.invalidMapping(result.invalid);
  }

  async list(uid: string, organizationId: string) {
    await requireOrgRole(this.store, uid, organizationId, "viewer");
    return (await this.store.projects.list(organizationId)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(uid: string, id: string, minRole: "viewer" | "member" = "viewer") {
    return authorizeResource(this.store, uid, await this.store.projects.get(id), "Project", minRole);
  }

  async create(uid: string, input: z.infer<typeof CreateProjectSchema>): Promise<Project> {
    await requireOrgRole(this.store, uid, input.organizationId, "member");
    const org = await this.store.organizations.get(input.organizationId);
    if (!org) throw Errors.notFound("Organization");
    await this.validateMapping(org, input.repositoryIds);
    const ts = this.now().toISOString();
    const project: Project = { id: `prj_${randomUUID()}`, ...input, createdAt: ts, updatedAt: ts };
    await this.store.projects.upsert(project);
    return project;
  }

  async update(uid: string, id: string, patch: z.infer<typeof UpdateProjectSchema>): Promise<Project> {
    const project = await this.get(uid, id, "member");
    const merged = { ...project, ...patch };
    if (merged.startDate && merged.dueDate && merged.startDate > merged.dueDate) throw Errors.validation([{ path: "dueDate", message: "dueDate must not be before startDate" }]);
    if (patch.repositoryIds) {
      const org = await this.store.organizations.get(project.organizationId);
      if (!org) throw Errors.notFound("Organization");
      await this.validateMapping(org, patch.repositoryIds);
    }
    const updated: Project = { ...merged, updatedAt: this.now().toISOString() };
    await this.store.projects.upsert(updated);
    return updated;
  }

  async listTasks(uid: string, projectId: string): Promise<Task[]> {
    await this.get(uid, projectId);
    return (await this.store.tasks.listByProject(projectId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createTask(uid: string, projectId: string, input: z.infer<typeof CreateTaskSchema>): Promise<Task> {
    const project = await this.get(uid, projectId, "member");
    const ts = this.now().toISOString();
    const task: Task = { id: `tsk_${randomUUID()}`, organizationId: project.organizationId, projectId, ...input, createdAt: ts, updatedAt: ts };
    await this.store.tasks.upsert(task);
    return task;
  }

  async getTask(uid: string, taskId: string, minRole: "viewer" | "member" = "viewer") {
    return authorizeResource(this.store, uid, await this.store.tasks.get(taskId), "Task", minRole);
  }

  async updateTask(uid: string, taskId: string, patch: z.infer<typeof UpdateTaskSchema>): Promise<Task> {
    const task = await this.getTask(uid, taskId, "member");
    const updated: Task = { ...task, ...patch, updatedAt: this.now().toISOString() };
    await this.store.tasks.upsert(updated);
    return updated;
  }
}
