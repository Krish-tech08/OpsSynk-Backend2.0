/** OpenAPI 3.1 description of the OpsSynk API (served at /api/v1/openapi.json and /api/docs). */
const orgQ = { name: "organizationId", in: "query", required: true, schema: { type: "string" } };
const pageQ = [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "cursor", in: "query", schema: { type: "string" } }];
const idP = (n: string) => ({ name: n, in: "path", required: true, schema: { type: "string" } });
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Repeat-safe creation (8–128 chars)." };
const ok = (desc: string, ref?: string) => ({ description: desc, content: { "application/json": { schema: { type: "object", properties: { success: { const: true }, data: ref ? { $ref: ref } : {}, meta: { type: "object" } } } } } });
const errs = { 400: { $ref: "#/components/responses/Error" }, 401: { $ref: "#/components/responses/Error" }, 403: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" } };
const body = (ref: string) => ({ required: true, content: { "application/json": { schema: { $ref: ref } } } });
const op = (tag: string, summary: string, extra: Record<string, unknown> = {}) => ({ tags: [tag], summary, security: [{ bearer: [] }], responses: { 200: ok("OK"), ...errs }, ...extra });

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "OpsSynk Backend API", version: "1.1.0",
    description: "Engineering command center API. All /api/v1 routes require a Firebase ID token (Authorization: Bearer). Responses use {success, data, meta} or {success:false, error:{code,message,requestId}}." },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "Firebase ID token" } },
    responses: { Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
    schemas: {
      Error: { type: "object", properties: { success: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" }, details: {} } } } },
      CreateProject: { type: "object", required: ["organizationId", "name"], properties: { organizationId: { type: "string" }, name: { type: "string" }, description: { type: "string" },
        teamId: { type: ["string", "null"] }, repositoryIds: { type: "array", items: { type: "string" }, description: "Repository names validated against the org's GitHub account." },
        ownerUid: { type: ["string", "null"] }, status: { enum: ["planning", "active", "on_hold", "completed", "cancelled"] }, priority: { enum: ["low", "medium", "high", "critical"] },
        startDate: { type: ["string", "null"], format: "date-time" }, dueDate: { type: ["string", "null"], format: "date-time" } } },
      CreateTask: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, status: { enum: ["todo", "in_progress", "blocked", "done"] },
        priority: { enum: ["low", "medium", "high", "critical"] }, assigneeUid: { type: ["string", "null"] }, dueDate: { type: ["string", "null"], format: "date-time" } } },
      CreateInvestigation: { type: "object", required: ["organizationId", "query"], properties: { organizationId: { type: "string" }, query: { type: "string" },
        scope: { type: "object", properties: { projectIds: { type: "array", items: { type: "string" } }, repositoryIds: { type: "array", items: { type: "string" } } } } } },
      CreateIncident: { type: "object", required: ["organizationId", "title", "severity"], properties: { organizationId: { type: "string" }, projectId: { type: ["string", "null"] },
        title: { type: "string" }, description: { type: "string" }, severity: { enum: ["sev1", "sev2", "sev3", "sev4"] }, status: { enum: ["open", "investigating", "mitigated", "resolved"] } } },
      InvestigationEvent: { type: "object", properties: { sequence: { type: "integer" }, investigationId: { type: "string" }, agentId: { type: ["string", "null"] },
        eventType: { type: "string" }, message: { type: "string" }, status: { type: "string" }, timestamp: { type: "string", format: "date-time" }, metadata: { type: "object" } } },
    },
  },
  paths: {
    "/health": { get: { tags: ["Diagnostics"], summary: "Liveness", responses: { 200: { description: "OK" } } } },
    "/ready": { get: { tags: ["Diagnostics"], summary: "Readiness of required dependencies (no secrets)", responses: { 200: { description: "Ready" }, 503: { description: "Not ready" } } } },
    "/api/v1/health/summary": { get: op("Diagnostics", "Company engineering-health summary", { parameters: [orgQ] }) },
    "/api/v1/projects": { get: op("Projects", "List projects", { parameters: [orgQ, ...pageQ] }),
      post: op("Projects", "Create a project (repository mapping validated)", { requestBody: body("#/components/schemas/CreateProject"), responses: { 201: ok("Created"), ...errs } }) },
    "/api/v1/projects/{projectId}": { get: op("Projects", "Get a project", { parameters: [idP("projectId")] }),
      patch: op("Projects", "Update a project", { parameters: [idP("projectId")], requestBody: body("#/components/schemas/CreateProject") }) },
    "/api/v1/projects/{projectId}/health": { get: op("Projects", "Deterministic project health with sub-scores and evidence", { parameters: [idP("projectId")] }) },
    "/api/v1/projects/{projectId}/tasks": { get: op("Tasks", "List tasks", { parameters: [idP("projectId"), ...pageQ] }),
      post: op("Tasks", "Create a task", { parameters: [idP("projectId")], requestBody: body("#/components/schemas/CreateTask"), responses: { 201: ok("Created"), ...errs } }) },
    "/api/v1/tasks/{taskId}": { get: op("Tasks", "Get a task", { parameters: [idP("taskId")] }), patch: op("Tasks", "Update a task", { parameters: [idP("taskId")] }) },
    "/api/v1/github/repositories": { get: op("GitHub", "Repositories in the organization (allowlist applied)", { parameters: [orgQ] }) },
    "/api/v1/github/repositories/{repositoryId}": { get: op("GitHub", "Repository summary signals", { parameters: [orgQ, idP("repositoryId")] }) },
    "/api/v1/github/repositories/{repositoryId}/issues": { get: op("GitHub", "Open issues (pull requests excluded)", { parameters: [orgQ, idP("repositoryId")] }) },
    "/api/v1/github/repositories/{repositoryId}/pulls": { get: op("GitHub", "Open pull requests with stale flag", { parameters: [orgQ, idP("repositoryId")] }) },
    "/api/v1/github/repositories/{repositoryId}/workflows": { get: op("GitHub", "Workflow runs in the CI window with stats", { parameters: [orgQ, idP("repositoryId")] }) },
    "/api/v1/github/sync": { post: op("GitHub", "Capture engineering snapshots (idempotent per hour, rate-limited)", { parameters: [orgQ] }) },
    "/api/v1/agents/investigations": { get: op("Investigations", "List investigations", { parameters: [orgQ] }),
      post: op("Investigations", "Start an investigation (async)", { parameters: [idem], requestBody: body("#/components/schemas/CreateInvestigation"), responses: { 202: ok("Accepted"), ...errs } }) },
    "/api/v1/agents/investigations/{investigationId}": { get: op("Investigations", "Investigation state, agent statuses and final report", { parameters: [idP("investigationId")] }) },
    "/api/v1/agents/investigations/{investigationId}/events": { get: op("Investigations", "Poll events (sequence > after)", { parameters: [idP("investigationId"), { name: "after", in: "query", schema: { type: "integer" } }] }) },
    "/api/v1/agents/investigations/{investigationId}/stream": { get: { tags: ["Investigations"], summary: "SSE stream (supports Last-Event-ID)", security: [{ bearer: [] }],
      parameters: [idP("investigationId"), { name: "Last-Event-ID", in: "header", schema: { type: "string" } }], responses: { 200: { description: "text/event-stream" } } } },
    "/api/v1/incidents": { get: op("Incidents", "List incidents", { parameters: [orgQ, ...pageQ] }),
      post: op("Incidents", "Create an incident", { requestBody: body("#/components/schemas/CreateIncident"), responses: { 201: ok("Created"), ...errs } }) },
    "/api/v1/incidents/{incidentId}": { get: op("Incidents", "Get an incident", { parameters: [idP("incidentId")] }), patch: op("Incidents", "Update an incident", { parameters: [idP("incidentId")] }) },
    "/api/v1/incidents/{incidentId}/investigate": { post: op("Incidents", "Investigate an incident", { parameters: [idP("incidentId"), idem], responses: { 202: ok("Accepted"), ...errs } }) },
    "/api/v1/analytics/company": { get: op("Analytics", "Company health with category scores, coverage, weights and bands", { parameters: [orgQ] }) },
    "/api/v1/analytics/projects": { get: op("Analytics", "Health of every project", { parameters: [orgQ] }) },
    "/api/v1/reports/{investigationId}": { get: op("Reports", "Final evidence-backed report (409 until ready)", { parameters: [idP("investigationId")] }) },
  },
};
