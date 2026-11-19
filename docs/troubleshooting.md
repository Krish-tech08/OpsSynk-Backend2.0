# Troubleshooting

## The server exits immediately with code 78

Exit code 78 means the configuration is invalid. The message names the problem:

| Message | Fix |
|---|---|
| `FIREBASE_PROJECT_ID is required when STORAGE_MODE=firestore` | Set `FIREBASE_PROJECT_ID`, or use `STORAGE_MODE=memory` locally |
| `FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase` | Set `FIREBASE_PROJECT_ID`, or use `AUTH_MODE=dev` locally |
| `GITHUB_TOKEN is required when GITHUB_MODE=live` | Add a read-only GitHub token, or use `GITHUB_MODE=fixture` |
| `AUTH_MODE=dev is not allowed when NODE_ENV=production` | Use `AUTH_MODE=firebase` in production |
| `ENABLED_AGENTS must include manager` | Keep `manager` in `ENABLED_AGENTS` |
| `Unknown agents in ENABLED_AGENTS: …` | Allowed values: manager, github, project, bug, devops, review |

Quickest way to run with no credentials:

```bash
STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm start
```

## Common API errors

| Status / code | Usual cause |
|---|---|
| 401 `UNAUTHENTICATED` | Missing or expired token. In dev mode the header must be `Authorization: Bearer dev:<uid>` |
| 404 `NOT_FOUND` on an organization you expect to see | You are not a member of that organization (non-members get 404, not 403, by design) |
| 403 `FORBIDDEN` | You are a member, but your role is too low (viewer < member < admin < owner) |
| 400 `VALIDATION_FAILED` | Check `error.details` for the field that failed |
| 400 `INVALID_REPOSITORY_MAPPING` | A repository name does not exist in the org's GitHub account, is archived, or is not on the allowlist |
| 503 `GITHUB_UNAVAILABLE` | GitHub could not be reached; project saves with repositories are refused rather than storing unchecked data |
| 429 `RATE_LIMITED` | Too many investigations or syncs; wait for the `Retry-After` header |
| 409 `REPORT_NOT_READY` | The investigation is still running; poll its events or stream |

## Investigations only use rules, not AI

`GEMINI_API_KEY` is not set. That is allowed: every number, finding and recommendation still works. Set the key to enable Gemini planning and summaries. `/ready` shows `gemini: "not_configured"` when no key is set.

## The browser gets CORS errors

Add the dashboard's origin to `CORS_ORIGINS` (comma-separated, exact origins such as `https://dashboard.example.com`). The Android app sends no `Origin` header and needs no CORS.

## The SSE stream does not work in the browser

`EventSource` cannot send the `Authorization` header. Use a `fetch`-based SSE client, or poll `GET /api/v1/agents/investigations/:id/events?after=N`.

## `npm install` or the build fails

- Check `node -v` is 22 or newer.
- Delete `node_modules` and run `npm install` again.
- Run `npm run typecheck` to see TypeScript errors with file and line.
