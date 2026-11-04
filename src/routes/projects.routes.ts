import { Router } from "express";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { Id, OrgQuery, PageQuery, paginate } from "../schemas/common.schemas.js";
import { CreateProjectSchema, CreateTaskSchema, UpdateProjectSchema, UpdateTaskSchema } from "../schemas/project.schemas.js";
import { ok } from "./respond.js";

export function projectRoutes(ctx: AppContext) {
  const r = Router();
  const uid = (req: any) => req.user!.uid as string;

  r.get("/projects", async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    const { limit, cursor } = parse(PageQuery, req.query);
    const page = paginate(await ctx.projects.list(uid(req), organizationId), limit, cursor);
    ok(res, page.items, { nextCursor: page.nextCursor, total: page.total });
  });
  r.post("/projects", async (req, res) => ok(res, await ctx.projects.create(uid(req), parse(CreateProjectSchema, req.body)), undefined, 201));
  r.get("/projects/:projectId", async (req, res) => ok(res, await ctx.projects.get(uid(req), parse(Id, req.params.projectId))));
  r.patch("/projects/:projectId", async (req, res) =>
    ok(res, await ctx.projects.update(uid(req), parse(Id, req.params.projectId), parse(UpdateProjectSchema, req.body))));
  r.get("/projects/:projectId/health", async (req, res) => {
    const project = await ctx.projects.get(uid(req), parse(Id, req.params.projectId));
    ok(res, await ctx.health.projectHealth(project));
  });
  r.get("/projects/:projectId/tasks", async (req, res) => {
    const { limit, cursor } = parse(PageQuery, req.query);
    const page = paginate(await ctx.projects.listTasks(uid(req), parse(Id, req.params.projectId)), limit, cursor);
    ok(res, page.items, { nextCursor: page.nextCursor, total: page.total });
  });
  r.post("/projects/:projectId/tasks", async (req, res) =>
    ok(res, await ctx.projects.createTask(uid(req), parse(Id, req.params.projectId), parse(CreateTaskSchema, req.body)), undefined, 201));
  r.get("/tasks/:taskId", async (req, res) => ok(res, await ctx.projects.getTask(uid(req), parse(Id, req.params.taskId))));
  r.patch("/tasks/:taskId", async (req, res) =>
    ok(res, await ctx.projects.updateTask(uid(req), parse(Id, req.params.taskId), parse(UpdateTaskSchema, req.body))));
  return r;
}
