# Architecture

One modular Node.js/TypeScript service (Express 5). There are no microservices, queues or Redis.

```
Android app / web dashboard
  → Express (request id, browser-only CORS, 100 kB body limit)
  → Firebase ID-token verification → organization membership + role check
  → Zod validation → services
  → Orchestrator → Manager plan → specialist agents → tool layer → GitHub / Firestore / deterministic metrics
  → evidence verification → Review agent → deterministic company health → Manager synthesis
  → report persisted in Firestore; events persisted and streamed (SSE + polling)
```

## Modules

| Path | Responsibility |
|---|---|
| `src/config/env.ts` | Validated configuration and modes; clear startup errors (exit code 78) |
| `src/middleware/` | Auth, browser CORS, rate limits, error envelope, request ids |
| `src/services/` | Authorization, projects/tasks, health, investigations, incidents |
| `src/repositories/` | `Store` interface; Firestore and in-memory implementations |
| `src/integrations/github/` | REST client (pagination, retries, rate limits, cache), normalization, fixture transport |
| `src/integrations/gemini/` | `@google/genai` transport, budgeted client, output validation |
| `src/domain/health/` | Metrics, formulas, aggregation, repository-mapping validation |
| `src/agents/` | Contract, tools, evidence ledger, Manager/GitHub/Project/Bug/DevOps/Review agents, orchestrator |
| `src/demo/` | Labelled demo dataset and idempotent seeding |

## The eight binding decisions

| # | Decision | Implementation |
|---|---|---|
| 1 | Organization-scoped membership | `organizations/{orgId}/members/{uid}` with role `viewer < member < admin < owner`. `requireOrgRole` / `authorizeResource` run before every org-scoped operation. Non-members get 404, insufficient roles get 403. |
| 2 | Validated repository mappings | `validateRepositoryMapping`: format, duplicates, allowlist, existence in the org's GitHub account, not archived. Checked on project create and update. If GitHub can't be reached, the save is refused (503) rather than storing an unchecked mapping. |
| 3 | Deterministic, configurable health formulas | `src/domain/health/`, documented in `health-scoring.md`; configuration validated at startup. |
| 4 | Correct issue filtering | `separateIssuesAndPullRequests` removes items with `pull_request` from GitHub's issues feed; responses report `pullRequestsExcluded`. |
| 5 | Evidence-based deployment reporting | Deployment state comes only from the GitHub Deployments API (records and statuses). Without records the report says "Deployment health not assessed". Workflow names and releases are never treated as deployments. |
| 6 | Persisted investigation events | `investigations/{id}/events/{seq}`; sequence assigned in a Firestore transaction. Exposed through polling (`/events?after=`) and SSE (`/stream` with `Last-Event-ID`). |
| 7 | Bounded Gemini calls | `ModelCallBudget` (per investigation, consumed before each attempt, retries included), `PerMinuteLimiter` (process-wide), reserved calls for review and synthesis, 429s never retried. |
| 8 | Browser-only CORS | `CORS_ORIGINS` allowlist; empty by default, meaning no CORS headers. Native clients send no `Origin` and are unaffected. |

## Investigation workflow

1. `POST /agents/investigations` validates input, deduplicates (`Idempotency-Key`, plus identical in-flight submits) and stores `queued`. It returns 202.
2. The orchestrator runs in-process (`setImmediate`). Status moves `queued → running → completed | partial | failed`; terminal states are final.
3. **Manager plan:** Gemini proposes a subset of the enabled specialists (Zod-validated enum); otherwise a rules plan is used.
4. **GitHub and Project** run concurrently, then **Bug and DevOps**. Each agent has a timeout, all bounded by `MAX_INVESTIGATION_DURATION_MS`.
5. Agents only reach data through **tools** (per-agent allowlist, Zod input, call budget, timeout, events with counts only). Every retrieved item is written to the **evidence ledger**.
6. **Verification:** every cited evidence item must exist in the ledger with identical details. Hypotheses are capped at medium severity; critical inferences need two evidence items.
7. **Review agent:** data-quality warnings, plus an optional Gemini check that can only *downgrade* inferences.
8. **Company health** is computed deterministically; the **Manager synthesis** uses Gemini (budgeted) or rules. Recommendations must cite verified finding IDs, and model text whose numbers don't appear in the data is rejected.
9. The report and terminal event are persisted. If an agent fails or times out, the investigation becomes `partial` and the gaps are listed in `unavailableData`.

The model never chooses tool arguments, URLs or database paths, and never runs code.

## Data model (Firestore)

| Collection | Notes |
|---|---|
| `organizations/{id}` | `githubOrganization`, `ownerUid` |
| `organizations/{id}/members/{uid}` | `role` (scoped to this organization) |
| `projects/{id}` | `organizationId`, `repositoryIds` (validated repository names), dates, status |
| `tasks/{id}` | `organizationId`, `projectId`, `status`, `dueDate`, `assigneeUid` |
| `incidents/{id}` | `organizationId`, `projectId`, `severity`, `investigationIds` |
| `investigations/{id}` | status, `agentStatuses`, `plan`, `finalReport`, budgets, `eventCount`, `idempotencyKey` |
| `investigations/{id}/events/{seq}` | persisted event log |
| `engineeringSnapshots/{orgId_repo_hour}` | written by `POST /github/sync`, idempotent per hour |

Demo records carry `isDemoData: true`; fixture GitHub links use the reserved host `fixtures.opssynk.invalid`.
Client access to Firestore is denied by `firestore.rules`; only the backend (Admin SDK) reads and writes data.
