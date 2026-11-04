# OpsSynk Backend

AI-powered engineering command center backend (spec v1.1): one modular Node.js 22 + TypeScript + Express 5 service,
backed by Firebase Firestore and Authentication, GitHub's REST API, and Gemini (`@google/genai`).

**Code calculates, Gemini interprets.** Counts, staleness, CI rates and health scores are deterministic TypeScript.
Gemini is optional and bounded: it plans, summarizes and drafts recommendations. Every claim cites evidence that a tool
actually retrieved, and that evidence is verified before it can reach a recommendation.

## Quick start (no credentials)

```bash
npm install
npm test                                   # 85 tests, ~5 s, no network
npm run build
STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm start
```

Then try the API:

```bash
H="Authorization: Bearer dev:demo-owner"; B=http://localhost:8080
curl $B/ready
curl -H "$H" "$B/api/v1/analytics/company?organizationId=org_demo"
curl -H "$H" -H "Content-Type: application/json" -X POST $B/api/v1/agents/investigations \
     -d '{"organizationId":"org_demo","query":"What is the current engineering health?"}'
curl -N -H "$H" "$B/api/v1/agents/investigations/<id>/stream"          # live agent events (SSE)
curl -H "$H" "$B/api/v1/reports/<id>"                                  # evidence-backed report
```

Swagger UI is at `http://localhost:8080/api/docs`. The fixture dataset is labelled demo data everywhere: `dataSource: "fixture"`,
`isDemoData`, and links on the reserved `fixtures.opssynk.invalid` host.

For real Firebase, GitHub and Gemini, see **[docs/setup.md](docs/setup.md)**. All configuration is in **[.env.example](.env.example)**.

## Documentation

| | |
|---|---|
| [docs/setup.md](docs/setup.md) | Local run, Firebase, GitHub token permissions, Gemini, Docker, Cloud Run, Android integration |
| [docs/api.md](docs/api.md) | Endpoints, envelopes, SSE protocol, report format, error codes |
| [docs/architecture.md](docs/architecture.md) | Modules, workflow, data model, how each of the eight binding decisions is implemented |
| [docs/health-scoring.md](docs/health-scoring.md) | Every formula, its missing-data behaviour, worked examples, configuration |
| [docs/assumptions.md](docs/assumptions.md) | Documented assumptions and known limitations |

## Modes

| Variable | Values | Default |
|---|---|---|
| `STORAGE_MODE` | `firestore` / `memory` (local, not persisted) | `firestore` |
| `AUTH_MODE` | `firebase` / `dev` (`Bearer dev:<uid>`, refused in production) | `firebase` |
| `GITHUB_MODE` | `live` / `fixture` (labelled demo dataset) | `live` |
| `GEMINI_API_KEY` | unset = rules-only (all numbers, findings and recommendations still work) | unset |

Misconfiguration stops the server at startup with a readable message (exit code 78), not an SDK stack trace.

## Phase report

Each phase was verified with automated tests before the next one began.

| Phase | Delivered | Verified by |
|---|---|---|
| 1. Foundation | Env validation, Firebase token verification, org-scoped roles (`members` subcollection), error envelope, request ids, browser-only CORS, rate limits, `/health`, `/ready`, Firestore and memory stores | `foundation.test.ts`, `authorization-mapping.test.ts`, env tests |
| 2. GitHub and projects | REST client (pagination, retries, rate limits, cache, truncation), issue/PR separation, deployment evidence, project/task CRUD with validated repository mapping, deterministic health formulas, snapshots, analytics, demo dataset and seeding | `github.test.ts`, `health-formulas.test.ts`, `projects-github.test.ts` (demo identifies 5 healthy / 4 warning / 3 critical) |
| 3. Gemini and first agents | Budgeted Gemini client, evidence ledger, tool layer, Manager (plan and synthesis), GitHub and Project agents, orchestrator, persisted events, polling and SSE, idempotency | `model-budget.test.ts`, `investigation-mvp.test.ts`: the Manager → GitHub → Project investigation was proven before Phase 4 |
| 4. Full workflow | Bug agent (hypotheses for similar bugs), DevOps agent (CI vs deployment evidence), Review agent (deterministic plus downgrade-only AI), partial-failure handling, timeouts, restart recovery | `investigation-full.test.ts` |
| 5. Incidents and showcase | Incident CRUD and investigation (incident cited as evidence), reports, company/project analytics, OpenAPI, Docker | `investigation-full.test.ts`, production-build smoke test |

**Test totals:** 85 tests in 10 files (unit and integration). Gemini, GitHub and Firebase are faked, so the suite makes no network calls and costs nothing.

**What is not verified here:**
* the real Gemini API (the SDK call path is type-checked only);
* real Firestore (an optional contract test runs against the emulator);
* live GitHub (the client is tested with a fake `fetch`, and the normalization with GitHub-shaped fixtures).

See [docs/assumptions.md](docs/assumptions.md).

## Project structure

```
src/
  app.ts, server.ts, context.ts, openapi.ts
  config/            env validation
  middleware/        auth, CORS, rate limit, errors, validation
  routes/            health, projects/tasks, github, analytics, agents (polling + SSE), incidents, reports
  services/          authorization, projects, health, investigations, incidents
  repositories/      Store interface, Firestore + memory implementations
  integrations/      github (client, service, fixture), gemini (client, budget), firebase (admin, verifier)
  domain/            health (metrics, formulas, aggregation, mapping), investigations (state, event bus), reports
  agents/            contract, tools + evidence ledger, manager, github, project, bug, devops, review, orchestrator
  demo/              labelled demo dataset + idempotent seeding
scripts/seed-demo.ts  Firestore demo seeding
tests/                unit/, integration/, helpers/
firestore.rules, firestore.indexes.json, Dockerfile, .env.example
```
