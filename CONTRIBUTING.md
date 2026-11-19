# Contributing to OpsSynk Backend

## Setup
1. Install Node.js 22 or newer and Git.
2. `git clone https://github.com/Krish-tech08/OpsSynk-Backend2.0.git && cd OpsSynk-Backend2.0`
3. `npm install`
4. `npm test` (every test should pass before you start).

To run the server locally without any credentials:

```bash
npm run build
STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm start
```

Then call the API with the header `Authorization: Bearer dev:demo-owner`.

## Branches
Never commit directly to `main`. Create a branch from an up-to-date `main`:

| Type of change | Branch name |
|---|---|
| New feature or endpoint | `feature/<short-description>-<yourname>` |
| Bug fix | `fix/<short-description>-<yourname>` |
| Documentation | `docs/<short-description>-<yourname>` |
| Tests only | `test/<short-description>-<yourname>` |

## Commit messages
Use a short prefix and the imperative mood:

- `feat: add version endpoint`
- `fix: handle missing project dates`
- `test: cover EvidenceLedger matching`
- `docs: add troubleshooting guide`
- `refactor: …`, `chore: …`

Keep each commit focused on one change.

## Code style
- TypeScript in `strict` mode with ES modules. Import local files with a `.js` extension (`../utils/time.js`).
- Validate all request input with Zod schemas (`src/schemas/`) and the `parse()` helper.
- Return responses through `ok()` in `src/routes/respond.ts` so they use the standard envelope.
- Throw errors from `Errors` in `src/utils/errors.ts`, never raw `Error`s, so clients get a stable error code.
- Every organization-scoped route must call `requireOrgRole` or `authorizeResource` before reading data.
- Numbers and scores are calculated in code. Gemini is only used to plan, summarize and draft text.

## Before opening a pull request
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] New behaviour has tests
- [ ] Docs updated if an endpoint or setting changed
- [ ] No secrets, `.env`, `node_modules/` or `dist/` committed

Open the pull request against `main` and ask a teammate to review it.
