import type { RepoSummary } from "../../integrations/github/github.types.js";

export type MappingProblem = "invalid_format" | "duplicate" | "not_in_allowlist" | "not_found_in_organization" | "archived";
export interface MappingResult { valid: string[]; invalid: Array<{ repositoryId: string; reason: MappingProblem }> }

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A project may only map repositories that exist in its organization's GitHub account, pass the allowlist
 * (when configured) and are not archived. Names are repository names without the owner (e.g. "mobile-app-ios").
 */
export function validateRepositoryMapping(requested: string[], available: RepoSummary[], allowlist: string[]): MappingResult {
  const byId = new Map(available.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const result: MappingResult = { valid: [], invalid: [] };
  for (const id of requested) {
    const reason: MappingProblem | null =
      !REPO_NAME.test(id) ? "invalid_format"
      : seen.has(id) ? "duplicate"
      : allowlist.length && !allowlist.includes(id) ? "not_in_allowlist"
      : !byId.has(id) ? "not_found_in_organization"
      : byId.get(id)!.archived ? "archived"
      : null;
    seen.add(id);
    if (reason) result.invalid.push({ repositoryId: id, reason });
    else result.valid.push(id);
  }
  return result;
}
