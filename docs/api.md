# API reference

Interactive docs: `GET /api/docs` (Swagger UI) · machine-readable: `GET /api/v1/openapi.json`.

All `/api/v1` routes require `Authorization: Bearer <Firebase ID token>`. Responses use one envelope:

```json
{ "success": true, "data": {}, "meta": {} }
{ "success": false, "error": { "code": "FORBIDDEN", "message": "…", "requestId": "req_…", "details": [] } }
```

`details` is included only for validation, mapping and rate-limit errors. Stack traces and provider errors are never returned.

## Endpoints

| Method & path | Role | Notes |
|---|---|---|
| `GET /health`, `GET /ready` | public | Liveness; readiness plus modes (no secrets) |
| `GET /api/v1/health/summary?organizationId=` | viewer | Company score, status, coverage |
| `GET/POST /api/v1/projects` | viewer / member | `repositoryIds` validated against the org's GitHub account |
| `GET/PATCH /api/v1/projects/:projectId` | viewer / member | |
| `GET /api/v1/projects/:projectId/health` | viewer | Sub-scores, inputs, evidence lists, repository errors |
| `GET/POST /api/v1/projects/:projectId/tasks` | viewer / member | Paginated with `limit` and `cursor` |
| `GET/PATCH /api/v1/tasks/:taskId` | viewer / member | |
| `GET /api/v1/github/repositories?organizationId=` | viewer | Allowlist applied |
| `GET /api/v1/github/repositories/:repo` | viewer | Summary signals; deployments shown as records, `"no_deployment_data"` or `"unavailable"` |
| `GET …/:repo/issues` | viewer | PRs excluded (`meta.pullRequestsExcluded`) |
| `GET …/:repo/pulls` | viewer | `stale` flag per PR |
| `GET …/:repo/workflows` | viewer | Runs plus CI stats |
| `POST /api/v1/github/sync?organizationId=` | member | Snapshots, idempotent per hour, rate-limited |
| `POST /api/v1/agents/investigations` | member | 202 on create, 200 for a duplicate. Supports the `Idempotency-Key` header. Rate-limited. |
| `GET /api/v1/agents/investigations?organizationId=` | viewer | List without report bodies (`hasReport`) |
| `GET /api/v1/agents/investigations/:id` | viewer | Full state, including `finalReport` |
| `GET /api/v1/agents/investigations/:id/events?after=N` | viewer | Polling |
| `GET /api/v1/agents/investigations/:id/stream` | viewer | SSE |
| `GET/POST /api/v1/incidents`, `GET/PATCH /api/v1/incidents/:id` | viewer / member | |
| `POST /api/v1/incidents/:id/investigate` | member | Scoped to the incident's project; the incident is cited as evidence |
| `GET /api/v1/analytics/company`, `/analytics/projects` | viewer | Includes weights, bands, coverage |
| `GET /api/v1/reports/:investigationId` | viewer | 409 `REPORT_NOT_READY` until finished |

Every GitHub response carries `meta.dataSource` (`github` or `fixture`) and `meta.isDemoData`.

## Starting and following an investigation

```bash
curl -X POST "$API/api/v1/agents/investigations" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"organizationId":"org_demo","query":"What is the current engineering health?","scope":{"projectIds":[],"repositoryIds":[]}}'
# → 202 {"data":{"investigationId":"inv_…","status":"queued","links":{…}}}
```

**SSE** (`/stream`): each event is sent as

```
id: 12
event: agent.findings_ready
data: {"sequence":12,"investigationId":"inv_…","agentId":"github","eventType":"agent.findings_ready","message":"…","status":"completed","timestamp":"…","metadata":{"findings":9}}
```

* To reconnect, send `Last-Event-ID: <last sequence>` (or `?after=N`). Missed events are replayed from Firestore, and nothing is restarted.
* Heartbeat comments (`: ping`) are sent every 15 s; the stream closes after `investigation.completed`, `investigation.partial` or `investigation.failed`.
* **Android:** use OkHttp's `EventSource` (okhttp-sse) with the Authorization header.
* **Browser:** `EventSource` can't set headers, so use a fetch-based SSE client (for example `@microsoft/fetch-event-source`).

**Polling fallback:** `GET /events?after=N` returns events after N, plus `meta.done` and `meta.lastSequence`.

Event types: `investigation.started`, `manager.plan_created`, `agent.started`, `tool.started`, `tool.completed` (metadata
`cached: true` for shared results), `tool.failed`, `agent.findings_ready`, `agent.failed`, `review.started`, `review.completed`,
`investigation.completed | partial | failed`. Metadata contains counts and codes only, never tokens or raw repository content.

## The final report

`status`, `executiveSummary` (+ `executiveSummarySource: model|rules`), `health` (deterministic company health), `agentSummaries`,
`findings[]`, `recommendations[]` (each cites `findingIds` of **verified** findings), `unavailableData[]`, `warnings[]`,
`dataProvenance` and `budgets` (model and tool calls used vs limits).

Each finding has:
* `kind`: `fact`, `inference` or `hypothesis`;
* `verification`: `verified`, `unverified` or `hypothesis`;
* `severity`;
* `evidence[]`, each item with `sourceType`, `sourceId` (for example `pr:mobile-app-ios#17`, `task:…`, `project-health:…`), `sourceUrl` and `details`;
* `limitations` and `reviewNotes`.

## Error codes

`VALIDATION_FAILED`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`,
`INVALID_REPOSITORY_MAPPING`, `MAPPING_VALIDATION_UNAVAILABLE`, `GITHUB_UNAVAILABLE`, `GITHUB_RATE_LIMITED`,
`GITHUB_UNAUTHORIZED`, `GITHUB_FORBIDDEN`, `GITHUB_NOT_FOUND`, `REPORT_NOT_READY`, `INTERNAL_ERROR`.

Inside reports you'll also see: `GEMINI_RATE_LIMITED`, `GEMINI_UNAVAILABLE`, `INVALID_MODEL_OUTPUT`,
`MODEL_BUDGET_EXCEEDED`, `TOOL_BUDGET_EXCEEDED` and `TIMEOUT`.
