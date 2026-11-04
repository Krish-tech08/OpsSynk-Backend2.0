import { z } from "zod";

export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "invalid identifier");
export const IsoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date").transform((v) => new Date(v).toISOString());
export const OrgQuery = z.object({ organizationId: Id });
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});

/** Opaque offset cursor pagination for bounded lists. */
export function paginate<T>(items: T[], limit: number, cursor?: string) {
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString()) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
  return { items: page, nextCursor: next, total: items.length };
}
