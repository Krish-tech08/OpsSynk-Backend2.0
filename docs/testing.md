# Testing

The test suite uses [Vitest](https://vitest.dev) and [supertest](https://github.com/ladjs/supertest).
GitHub, Gemini and Firebase are replaced by fakes, so tests make **no network calls** and need **no credentials**.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run every test once |
| `npm run test:watch` | Re-run tests when files change |
| `npx vitest run tests/unit/health-formulas.test.ts` | Run one file |
| `npx vitest run -t "verifyFindings"` | Run tests whose name matches |
| `npm run typecheck` | Type-check source and tests without building |

## Layout

```
tests/
  helpers/      shared setup: test app, fake auth, fixed clock, scripted Gemini
  unit/         pure functions and classes, no HTTP
  integration/  full HTTP requests against the Express app (in-memory store)
```

### Unit tests
| File | Covers |
|---|---|
| `authorization-mapping.test.ts` | Organization roles and repository-mapping validation |
| `github.test.ts` | GitHub client: pagination, retries, rate limits, issue/PR separation |
| `health-formulas.test.ts` | Deterministic health scores and missing-data behaviour |
| `metrics-contract.test.ts` | Metric calculations, agent contract, evidence verification, tool runner, env validation |
| `model-budget.test.ts` | Gemini call budget and per-minute limiter |
| `org-sync.test.ts` | Syncing the organization's demo projects |
| `time-utils.test.ts` | `daysBetween`, `iso`, `backoffMs` |
| `evidence-ledger.test.ts` | Recording and matching evidence |
| `verification.test.ts` | Finding verification and severity caps |

### Integration tests
| File | Covers |
|---|---|
| `foundation.test.ts` | Auth, roles, validation, CORS, rate limits, `/health`, `/ready` |
| `projects-github.test.ts` | Projects, tasks, GitHub endpoints, analytics |
| `investigation-mvp.test.ts` | Manager → GitHub → Project investigation |
| `investigation-full.test.ts` | All agents, partial failures, incidents, reports |
| `firestore-store.test.ts` | Store contract (memory; Firestore when the emulator is running) |
| `meta-routes.test.ts` | `/version` and `/organizations/:id/me` |

## Test helpers (`tests/helpers/setup.ts`)

- `makeApp()` builds the app with an in-memory store, fixture GitHub data and the demo organization `org_demo` already seeded.
- `auth(uid)` returns the header for a fake user. Use `OWNER`, `VIEWER` or `OUTSIDER` (not a member).
- `NOW` and `clock` freeze time at `2026-10-26T12:00:00Z`, so results never depend on today's date.
- `scriptedGemini(handler)` fakes Gemini responses.

Example:

```ts
import request from "supertest";
import { auth, makeApp, OWNER } from "../helpers/setup.js";

it("lists projects for the owner", async () => {
  const { app } = await makeApp();
  const r = await request(app).get("/api/v1/projects?organizationId=org_demo").set(auth(OWNER));
  expect(r.status).toBe(200);
});
```

## Running against the Firestore emulator (optional)

```bash
firebase emulators:start --only firestore
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test
```

Without `FIRESTORE_EMULATOR_HOST`, the Firestore contract test only runs against the memory store.
