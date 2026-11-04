import type { Store } from "../repositories/store.js";
import { ROLE_RANK, type Membership, type Role } from "../types/domain.js";
import { Errors } from "../utils/errors.js";

/**
 * Organization-scoped authorization. Every organization-scoped operation calls this before touching data.
 * Non-members get 404 (the organization's existence is not revealed); members below the required role get 403.
 */
export async function requireOrgRole(store: Store, uid: string, organizationId: string, minRole: Role): Promise<Membership> {
  const membership = await store.members.get(organizationId, uid);
  if (!membership) throw Errors.notFound("Organization");
  if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) throw Errors.forbidden(`This action requires the ${minRole} role or higher.`);
  return membership;
}

/** Load an org-owned resource and authorize against the organization it belongs to. Missing or foreign → 404. */
export async function authorizeResource<T extends { organizationId: string }>(
  store: Store, uid: string, resource: T | null, what: string, minRole: Role,
): Promise<T> {
  if (!resource) throw Errors.notFound(what);
  const membership = await store.members.get(resource.organizationId, uid);
  if (!membership) throw Errors.notFound(what);
  if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) throw Errors.forbidden(`This action requires the ${minRole} role or higher.`);
  return resource;
}
