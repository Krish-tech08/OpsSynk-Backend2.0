import { z } from "zod";
import { Id, IsoDate } from "./common.schemas.js";

const ProjectFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  teamId: z.string().max(64).nullable().default(null),
  repositoryIds: z.array(z.string().max(100)).max(20).default([]),
  ownerUid: z.string().max(128).nullable().default(null),
  status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).default("planning"),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  startDate: IsoDate.nullable().default(null),
  dueDate: IsoDate.nullable().default(null),
};
const datesOrdered = (v: { startDate?: string | null; dueDate?: string | null }) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate;

export const CreateProjectSchema = z.object({ organizationId: Id, ...ProjectFields })
  .refine(datesOrdered, { message: "dueDate must not be before startDate", path: ["dueDate"] });

export const UpdateProjectSchema = z.object({
  name: ProjectFields.name.optional(), description: z.string().max(2000).optional(), teamId: z.string().max(64).nullable().optional(),
  repositoryIds: z.array(z.string().max(100)).max(20).optional(), ownerUid: z.string().max(128).nullable().optional(),
  status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  startDate: IsoDate.nullable().optional(), dueDate: IsoDate.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "at least one field is required");

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  assigneeUid: z.string().max(128).nullable().default(null),
  dueDate: IsoDate.nullable().default(null),
});
export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(4000).optional(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assigneeUid: z.string().max(128).nullable().optional(), dueDate: IsoDate.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "at least one field is required");
