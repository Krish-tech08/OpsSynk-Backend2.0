# OpsSynk Backend: the API and AI engine behind OpsSynk

**Live website:** https://ops-synk-website.onrender.com/
**Visual guide (no login needed):** https://ops-synk-website.onrender.com/learn
**Website source code:** https://github.com/Krish-tech08/ops-synk-website
**Demo GitHub organization:** https://github.com/SynkStack

OpsSynk tells a manager, in plain language and with proof, how healthy their software projects are, where work is stuck, and what to do next.
**This repository is the backend.** It reads GitHub and project data, calculates the health scores, runs the six AI agents, verifies their evidence, and serves everything to the website through a secure REST API with live updates.

> **Code calculates, AI interprets.** Every number (counts, staleness, CI pass rates, health scores) comes from deterministic TypeScript.
> Gemini only plans, summarizes and drafts recommendations, and every claim it makes must cite evidence that a tool actually retrieved.

---

## Table of contents

1. [How the pieces fit together](#1-how-the-pieces-fit-together)
2. [What the backend does](#2-what-the-backend-does)
3. [Architecture](#3-architecture)
4. [The six AI agents](#4-the-six-ai-agents)
5. [Safety and trust](#5-safety-and-trust)
6. [Health scoring](#6-health-scoring)
7. [API overview](#7-api-overview)
8. [Technology stack](#8-technology-stack)
9. [Project structure](#9-project-structure)
10. [Running locally](#10-running-locally)
11. [Tests](#11-tests)
12. [Deployment](#12-deployment)
13. [Configuration](#13-configuration)
14. [Suggested walkthrough for an examiner](#14-suggested-walkthrough-for-an-examiner)
15. [Limitations and future work](#15-limitations-and-future-work)
16. [Team](#16-team)

---

## 1. How the pieces fit together

| Part | Link | What it is |
|---|---|---|
| **Website** (frontend) | [ops-synk-website.onrender.com](https://ops-synk-website.onrender.com/) · [source](https://github.com/Krish-tech08/ops-synk-website) | React + TypeScript dashboard. It only displays what this backend returns. |
| **Backend** (this repo) | [github.com/Krish-tech08/OpsSynk-Backend2.0](https://github.com/Krish-tech08/OpsSynk-Backend2.0) | REST API, health scoring, six-agent pipeline, Firestore access, Gemini calls |
| **Demo organization** | [github.com/SynkStack](https://github.com/SynkStack) | The GitHub organization whose repositories OpsSynk monitors in the demo |

The demo organization's projects are mapped to their real repositories:

| Project | Repository | Team |
|---|---|---|
| AuthCore | [SynkStack/AuthCore](https://github.com/SynkStack/AuthCore) | Platform |
| NotificationHub | [SynkStack/NotificationHub](https://github.com/SynkStack/NotificationHub) | Platform |
| FieldTrack | [SynkStack/mobile-fieldtrack](https://github.com/SynkStack/mobile-fieldtrack) | Mobile |
| GrindQuest | [SynkStack/mobile-grindquest](https://github.com/SynkStack/mobile-grindquest) | Mobile |

---

## 2. What the backend does

- **Collects data, read-only,** from GitHub (issues, pull requests, workflow runs, commits, deployments) and from OpsSynk's own Firestore data (projects, tasks, incidents).
- **Scores** every project and the whole company from 0 to 100 across five areas (delivery, CI/CD, bugs, pull requests and activity), using fixed, documented and configurable formulas.
- **Investigates** questions asked in plain English with six AI agents, and streams every step live to the website.
- **Verifies** every AI finding against the evidence actually retrieved before it can reach a report.
- **Reports** an executive summary, findings with evidence links, recommendations that cite verified findings, and a list of data that could not be checked.
- **Protects** the data with Firebase sign-in, roles scoped to each organization, input validation, rate limits and a CORS allowlist.

---

## 3. Architecture

One modular Node.js service (no microservices, queues or Redis):

```
 Website (React)  ── HTTPS + Firebase ID token ──►  Express 5 API (this repo)
                  ◄── JSON + live SSE stream ─────   │
                                                     │ request id → CORS allowlist → 100 kB body limit
                                                     │ → Firebase token check → organization role check → Zod validation
                                                     ▼
                     ┌────────────────── services ──────────────────┐
                     │ projects · tasks · health · incidents ·      │
                     │ investigations → agent orchestrator          │
                     └──────┬──────────────┬──────────────┬─────────┘
                            ▼              ▼              ▼
                     Firestore       GitHub REST API   Gemini (optional, budgeted)
                  (Store interface)    (read-only)
```

- **Routes** handle HTTP. **Services** hold the business rules. **Repositories** (a `Store` interface with Firestore and in-memory versions) hold the data. **Integrations** talk to GitHub, Gemini and Firebase.
- Investigations run in-process after a `202 Accepted`. Every step is saved as a numbered event in Firestore and pushed over Server-Sent Events, with a polling fallback.

The full design, including the eight binding design decisions, is in [docs/architecture.md](docs/architecture.md).

---

## 4. The six AI agents

| # | Agent | Responsibility |
|---|---|---|
| 1 | **Manager** | Plans which specialists are needed, then writes the final summary and recommendations |
| 2 | **GitHub** | Pull requests, staleness and repository activity |
| 3 | **Project** | Tasks, deadlines, blocked and overdue work, project health |
| 4 | **Bug** | Open bugs by severity; similar-looking bugs are reported only as hypotheses |
| 5 | **DevOps** | CI workflow results and deployment records |
| 6 | **Review / QA** | Data-quality warnings and an AI check that can only *downgrade* findings |

```
                          ┌──► GitHub agent  ──┐          ┌──► Bug agent    ──┐
 Question ──► Manager ────┤                    ├──────────┤                    ├──► Verification ──► Review ──► Company health ──► Manager synthesis ──► Report
             (plan)       └──► Project agent ──┘          └──► DevOps agent ──┘   (evidence check)    (QA)       (formulas)         (summary + actions)
```

- Agents reach data **only through tools** (`listRepositories`, `getRepositorySignals`, `listProjects`, `getProjectTasks`, `calculateProjectHealth`, `calculateCompanyHealth`, `getIncidentDetails`). Each agent has an allowlist of tools, Zod-validated input, a call budget and a timeout.
- Everything a tool returns is written to the **evidence ledger**. The model never chooses tool arguments, URLs or database paths, and never runs code.
- If an agent fails or times out, the investigation finishes as **partial** and the report lists the missing data.

---

## 5. Safety and trust

| Safeguard | How it works |
|---|---|
| Numbers come from code | Scores, counts, staleness and CI rates are computed by fixed rules; the AI cannot change them |
| Evidence ledger | A finding can only cite evidence that a tool really fetched, with identical details |
| Deterministic verification | Missing or mismatched evidence → *unverified*. Hypotheses are capped at medium severity. A critical inference needs at least two evidence items. |
| Downgrade-only review | The Review agent's AI check can lower a finding's severity, never raise it |
| Grounded recommendations | Recommendations must cite verified finding IDs; AI text with numbers that are not in the data is rejected |
| Rules-only fallback | Without Gemini (no key, quota or outage) every number, finding and recommendation still works |
| Budgets | Per investigation: 8 model calls, 100 tool calls, 45 s per agent, 120 s in total, plus a server-wide per-minute model limit |
| Access control | Firebase ID-token verification on every request; roles `viewer < member < admin < owner` per organization; non-members get 404 |
| Read-only GitHub | A fine-grained, read-only token. OpsSynk never writes to GitHub. |
| No direct database access | `firestore.rules` deny all client access; only the backend (Admin SDK) reads and writes |

---

## 6. Health scoring

Each project gets five sub-scores (0–100), combined with these weights:

| Area | Weight | What lowers the score |
|---|---|---|
| Project delivery | 30% | Overdue tasks, blocked tasks, falling behind schedule |
| CI/CD | 25% | Low pass rate and consecutive failures on the default branch |
| Bugs | 20% | Open bugs weighted by severity (critical 25, high 10, medium 4, low 1) |
| Pull requests | 15% | Pull requests with no update for 7+ days |
| Repository activity | 10% | No recent commits, low commit volume |

- Bands: **healthy ≥ 80**, **warning ≥ 50**, **critical < 50**.
- A missing signal is **never counted as 0**. It is left out and the other weights are rescaled. If less than half the weight has data, the status is **insufficient_data**.
- GitHub's issues feed also contains pull requests; they are removed before bugs are counted.
- Deployment health comes **only** from GitHub Deployments records; without them it is reported as *not assessed*.

Every formula, worked example and configuration option is in [docs/health-scoring.md](docs/health-scoring.md).

---

## 7. API overview

Base path `/api/v1`. Every route except the public ones needs `Authorization: Bearer <Firebase ID token>`.
Interactive docs: **`/api/docs`** (Swagger UI). Machine-readable spec: `/api/v1/openapi.json`.

| Area | Endpoints |
|---|---|
| Service status (public) | `GET /health`, `GET /ready`, `GET /version` |
| Membership | `GET /organizations/:organizationId/me` |
| Health | `GET /health/summary` |
| Projects and tasks | `GET/POST /projects`, `GET/PATCH /projects/:id`, `GET /projects/:id/health`, `GET/POST /projects/:id/tasks`, `GET/PATCH /tasks/:id` |
| GitHub | `GET /github/repositories`, `…/:repo`, `…/:repo/issues`, `…/:repo/pulls`, `…/:repo/workflows`, `POST /github/sync` |
| Analytics | `GET /analytics/company`, `GET /analytics/projects` |
| AI investigations | `POST /agents/investigations`, `GET /agents/investigations`, `GET …/:id`, `GET …/:id/events?after=N`, `GET …/:id/stream` (SSE) |
| Incidents | `GET/POST /incidents`, `GET/PATCH /incidents/:id`, `POST /incidents/:id/investigate` |
| Reports | `GET /reports/:investigationId` |

Responses use one envelope: `{ "success": true, "data": …, "meta": … }` or `{ "success": false, "error": { "code", "message", "requestId" } }`.
Details, the SSE protocol, the report format and all error codes are in [docs/api.md](docs/api.md).

---

## 8. Technology stack

| Layer | Technology | Why |
|---|---|---|
| Runtime and language | Node.js 22 + TypeScript (strict) | Same language as the website; strict types catch bugs early |
| HTTP framework | Express 5 | Simple and widely known; async errors are handled automatically |
| Authentication | Firebase Authentication (Admin SDK) | The website signs in with Firebase; the backend only verifies ID tokens |
| Database | Cloud Firestore | Serverless, no database server to run; transactions keep event order correct |
| Engineering data | GitHub REST API | The real source of issues, PRs, CI runs and deployments |
| AI model | Google Gemini via `@google/genai` | Fast Flash-class model; optional and budgeted |
| Validation | Zod | One schema gives validation and TypeScript types |
| Logging | Pino | Structured JSON logs with request ids |
| API docs | OpenAPI + Swagger UI | Interactive, always available at `/api/docs` |
| Tests | Vitest + supertest | Fast; the API is called without opening a port |
| Packaging | Docker (multi-stage, non-root) | The same image runs locally and in the cloud |

---

## 9. Project structure

```
src/
  app.ts, server.ts, context.ts, openapi.ts   # app wiring, startup, dependency context, API spec
  config/            # environment validation (clear startup errors, exit code 78)
  middleware/        # auth, CORS, rate limits, error envelope, validation
  routes/            # health/version, projects & tasks, github, analytics, agents (polling + SSE), incidents, reports
  services/          # authorization, projects, health, investigations, incidents
  repositories/      # Store interface; Firestore and in-memory implementations
  integrations/      # github (client, service, fixture), gemini (client, budget), firebase (admin, verifier)
  domain/            # health formulas and metrics, investigation state and event bus, report types
  agents/            # contract, tools + evidence ledger, manager, github, project, bug, devops, review, orchestrator
  demo/              # labelled demo dataset and SynkStack organization sync
scripts/seed-demo.ts # Firestore seeding
tests/               # unit/, integration/, helpers/
docs/                # architecture, API, health scoring, setup, assumptions
firestore.rules, firestore.indexes.json, Dockerfile, .env.example
```

---

## 10. Running locally

### With no credentials (fastest)

```bash
npm install
npm run build
STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm start
```

This uses an in-memory database, a clearly labelled demo GitHub dataset and dev tokens. On Windows PowerShell, set each variable first (`$env:STORAGE_MODE="memory"` and so on), then run `npm start`.

```bash
H="Authorization: Bearer dev:demo-owner"; B=http://localhost:8080
curl $B/ready
curl -H "$H" "$B/api/v1/analytics/company?organizationId=org_demo"
curl -H "$H" -H "Content-Type: application/json" -X POST $B/api/v1/agents/investigations \
     -d '{"organizationId":"org_demo","query":"What is the current engineering health?"}'
curl -N -H "$H" "$B/api/v1/agents/investigations/<id>/stream"     # live agent events (SSE)
curl -H "$H" "$B/api/v1/reports/<id>"                             # evidence-backed report
```

Swagger UI: http://localhost:8080/api/docs

### With real Firebase, GitHub and Gemini

Copy `.env.example` to `.env`, fill in `FIREBASE_PROJECT_ID`, `GITHUB_ORG`, `GITHUB_TOKEN` (fine-grained, read-only) and optionally `GEMINI_API_KEY`, then run `npm run dev`.
The step-by-step guide (service account, token permissions, seeding your own user as owner) is in [docs/setup.md](docs/setup.md).

### Connecting the website

The website calls this API from the browser, so its origin must be allowed:

```
CORS_ORIGINS=https://ops-synk-website.onrender.com,http://localhost:5173
```

Use exact origins: no trailing slash and no path. Native clients and server-to-server calls send no `Origin` header and are not affected.

---

## 11. Tests

```bash
npm test            # 110 tests in 15 files, a few seconds, no network
npm run typecheck
```

GitHub, Gemini and Firebase are replaced with fakes, so the suite is fast, free and repeatable. It covers authorization and roles, validation and error envelopes, CORS, rate limits, the GitHub client, every health formula, the evidence ledger and verification, the model budget, the full six-agent workflow including partial failures and restart recovery, incidents, reports and the info endpoints.
An optional contract test runs against the Firestore emulator (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test`).

---

## 12. Deployment

The backend is deployed as a Docker web service on **Render**, next to the website.

```bash
docker build -t opssynk-backend .
docker run -p 8080:8080 --env-file .env opssynk-backend
```

- **Single instance:** investigations and SSE fan-out run in-process. Events are persisted, so polling works after a restart. An investigation interrupted by a restart is marked failed with a clear message.
- **Free tier:** the service sleeps when idle, so the first request can take up to a minute. Call `/health` before a demo.
- **Production rules:** `AUTH_MODE=dev` is refused when `NODE_ENV=production`. Use the platform's service identity or a secret file for Firebase credentials; never commit keys.
- Deploy the Firestore rules and indexes with `firebase deploy --only firestore:indexes,firestore:rules`.

Cloud Run settings and other options are in [docs/setup.md](docs/setup.md).

---

## 13. Configuration

All settings are environment variables, validated at startup. A misconfiguration stops the server with a readable message (exit code 78). See [.env.example](.env.example).

| Variable | Values | Default |
|---|---|---|
| `STORAGE_MODE` | `firestore` / `memory` (local, not persisted) | `firestore` |
| `AUTH_MODE` | `firebase` / `dev` (`Bearer dev:<uid>`, refused in production) | `firebase` |
| `GITHUB_MODE` | `live` / `fixture` (labelled demo dataset) | `live` |
| `GITHUB_ORG`, `GITHUB_TOKEN` | Organization to read, and a read-only token | — |
| `GEMINI_API_KEY` | Unset = rules-only (everything still works) | unset |
| `CORS_ORIGINS` | Comma-separated website origins | empty (no CORS) |
| `DEMO_MODE` | `true` seeds and syncs the demo organization | `false` |
| `MAX_MODEL_CALLS_PER_INVESTIGATION` | Gemini calls per investigation | `8` |
| `INVESTIGATION_RATE_LIMIT`, `SYNC_RATE_LIMIT` | Per user, per `RATE_LIMIT_WINDOW_MS` (10 min) | `10`, `5` |

---

## 14. Suggested walkthrough for an examiner

1. Open `/health`, `/ready` and `/version` on the deployed API to see the service status and active modes.
2. Open `/api/docs` (Swagger UI) to browse every endpoint and its schemas.
3. On the [website](https://ops-synk-website.onrender.com/), start an investigation and watch the live agent events. They come from `GET /agents/investigations/:id/stream`.
4. Open the finished report: findings typed as fact, inference or hypothesis, evidence links to [SynkStack](https://github.com/SynkStack) repositories, and recommendations that cite verified findings.
5. In the code, follow one investigation: [`src/agents/orchestrator/agent.orchestrator.ts`](src/agents/orchestrator/agent.orchestrator.ts) → [`src/agents/tools/evidence-ledger.ts`](src/agents/tools/evidence-ledger.ts) → [`src/agents/review/verification.ts`](src/agents/review/verification.ts).
6. Check the scoring rules in [`src/domain/health/formulas.ts`](src/domain/health/formulas.ts) against [docs/health-scoring.md](docs/health-scoring.md).
7. Run `npm test` to see the whole suite pass without any credentials.

---

## 15. Limitations and future work

**Current limitations**

- Single instance: the event fan-out and rate limiters are in memory.
- Data is pulled from GitHub at investigation time (with a short cache and `/github/sync` snapshots). Webhooks are not implemented yet.
- Only the newest 10 deployment records are read per repository.
- The real Gemini and live GitHub call paths are type-checked; the automated tests use fakes.

More detail is in [docs/assumptions.md](docs/assumptions.md).

**Possible future work**

- GitHub webhooks for real-time updates, and a GitHub App installation flow
- A shared event channel (Redis or Pub/Sub) to run several instances
- Health-score history, trends and deadline-risk forecasting
- Scheduled investigations with email or Slack digests
- More integrations: Jira, GitLab, Slack alerts, cloud monitoring

---

## 16. Team

OpsSynk is a collaborative college project by:

- **Krish Kumar Chaurasia**
- **Kanishka Tyagi**
- **Kanishka Lodhi**
- **Ishita Srivastava**

For individual work, see the commit history and pull requests in this repository, the [website repository](https://github.com/Krish-tech08/ops-synk-website) and the [SynkStack organization](https://github.com/SynkStack).

---

*OpsSynk: built so that anyone, technical or not, can understand the health of their engineering work and trust the answer.*
