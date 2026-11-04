# Setup and deployment

## 1. Local demo (no credentials)

```bash
npm install
npm run build
PORT=8080 STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm start
# or, with live reload:
STORAGE_MODE=memory AUTH_MODE=dev GITHUB_MODE=fixture DEMO_MODE=true npm run dev
```

This seeds the labelled demo organization `org_demo` in memory. The owner is `demo-owner` and the viewer is `demo-viewer`; override them with `DEMO_OWNER_UID` and `DEMO_VIEWER_UID`.
Call the API with `Authorization: Bearer dev:demo-owner`. Dev auth is refused when `NODE_ENV=production`.

```bash
curl -H "Authorization: Bearer dev:demo-owner" "http://localhost:8080/api/v1/analytics/company?organizationId=org_demo"
```

## 2. Tests

```bash
npm test            # 84 tests; Gemini, GitHub and Firebase are faked, so no network or cost
npm run typecheck
```

Optional Firestore contract test:

```bash
firebase emulators:start --only firestore
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test
```

## 3. Firebase

1. Create a Firebase project and enable **Authentication** (any provider the Android app uses) and **Firestore** (Native mode).
2. Deploy the indexes and rules: `firebase deploy --only firestore:indexes,firestore:rules` (files are in the repository root).
3. Credentials:
   * **Locally:** create a service account with the *Cloud Datastore User* and *Firebase Authentication Admin* roles, download its key **outside the repository**, and set `GOOGLE_APPLICATION_CREDENTIALS=/path/key.json`.
   * **In production:** prefer the hosting platform's service identity (Application Default Credentials) over key files.
4. Seed the demo organization with **your own Firebase UID** as owner:
   ```bash
   FIREBASE_PROJECT_ID=… SEED_OWNER_UID=<your uid> GITHUB_ORG=<org> GITHUB_TOKEN=… npm run seed:demo
   ```
   Seeding is idempotent and never overwrites records that aren't flagged `isDemoData`. With a token, it warns about demo repositories missing from your organization.
5. To grant other users access, create `organizations/org_demo/members/{uid}` documents with `role` set to `viewer`, `member`, `admin` or `owner`.

## 4. GitHub

Create a **fine-grained personal access token** (or a GitHub App installation) for the organization, read-only:

* **Repository permissions:** Metadata, Contents, Issues, Pull requests, Actions, Deployments.
* **Repository access:** the demo repositories (or all).

Set `GITHUB_MODE=live`, `GITHUB_ORG` and `GITHUB_TOKEN`, and optionally `GITHUB_REPOSITORY_ALLOWLIST`.

Map projects to repositories by **repository name** (`mobile-app-ios`, not `org/mobile-app-ios`). Names that don't exist in the organization are rejected.
Edit `src/demo/demo-dataset.ts` so the demo projects point at your teammate's real repositories.

## 5. Gemini (optional)

Set `GEMINI_API_KEY`, and `GEMINI_MODEL` to a Flash-class model available to your key. Check the model list in Google AI Studio, because availability and free-tier limits change.

Without a key the backend runs **rules-only**: every number, finding and recommendation still works; only the AI narration and planning are skipped.

Calls per investigation are capped by `MAX_MODEL_CALLS_PER_INVESTIGATION` (default 8: plan + four agent summaries + review + synthesis, some optional).
`GEMINI_MAX_CALLS_PER_MINUTE` protects the account's per-minute quota.

## 6. Deploy (Docker)

```bash
docker build -t opssynk-backend .
docker run -p 8080:8080 --env-file .env opssynk-backend
```

* **Single instance.** Investigations run in-process and SSE fan-out is in memory. Running more than one instance would split them; events are still persisted, so polling works across instances, but don't scale out without adding a shared event channel.
* **Cloud Run:** set *CPU always allocated*. Investigations continue after the 202 response, and request-only CPU allocation throttles that background work. Also set min and max instances to 1, and a request timeout of at least 300 s for SSE.
* **Render and other free tiers** sleep when idle: the first request can take 30–60 s. Call `/health` before a demo.
* Set `CORS_ORIGINS` only if a browser dashboard calls the API.

## 7. Android integration

* Send the Firebase ID token from `FirebaseAuth.getInstance().currentUser.getIdToken(false)` as `Authorization: Bearer …`, and refresh it on 401.
* Start an investigation with a fresh `Idempotency-Key` per user action. On 202, open `…/stream` with OkHttp SSE; if the stream drops, reconnect with `Last-Event-ID`, or poll `…/events?after=N`.
* When `meta.dataSource` is `fixture`, or `isDemoData` / `containsDemoData` is true, show a **Demo data** label.
