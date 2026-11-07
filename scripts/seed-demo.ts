/**
 * Seeds the labelled demo organization into Firestore (idempotent; never overwrites non-demo data).
 *
 *   SEED_OWNER_UID=<your Firebase uid> [SEED_VIEWER_UID=<uid>] FIREBASE_PROJECT_ID=<id> GITHUB_ORG=<org> npm run seed:demo
 *
 * With GITHUB_ORG set and GITHUB_TOKEN available, the script checks that each demo repository exists
 * in that organization and warns about missing ones (edit src/demo/demo-dataset.ts to match real names).
 */
import { initFirebase, firestore } from "../src/integrations/firebase/admin.js";
import { createFirestoreStore } from "../src/repositories/firestore.store.js";
import { seedDemo } from "../src/demo/seed.js";
import { DEMO_GITHUB_ORG, DEMO_OWNER_UID, DEMO_PROJECTS } from "../src/demo/demo-dataset.js";
import { createGitHubClient } from "../src/integrations/github/github.client.js";

const projectId = process.env.FIREBASE_PROJECT_ID;
const ownerUid = process.env.SEED_OWNER_UID ?? DEMO_OWNER_UID;
if (!projectId || !ownerUid) {
  console.error("FIREBASE_PROJECT_ID and SEED_OWNER_UID are required.");
  process.exit(1);
}
const githubOrganization = process.env.GITHUB_ORG ?? DEMO_GITHUB_ORG;

if (process.env.GITHUB_TOKEN && process.env.GITHUB_ORG) {
  const gh = createGitHubClient({ baseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", token: process.env.GITHUB_TOKEN, timeoutMs: 10_000, maxPages: 5, cacheTtlMs: 0 });
  const repos = new Set((await gh.getPaginated<{ name: string }>(`/orgs/${githubOrganization}/repos`)).items.map((r) => r.name));
  const missing = DEMO_PROJECTS.filter((p) => !repos.has(p.repository)).map((p) => p.repository);
  if (missing.length) console.warn(`WARNING: these demo repositories do not exist in ${githubOrganization}: ${missing.join(", ")}.\n` +
    "Their projects will report unavailable GitHub data. Edit src/demo/demo-dataset.ts to match your repositories.");
  else console.log(`All ${DEMO_PROJECTS.length} demo repositories exist in ${githubOrganization}.`);
}

const store = createFirestoreStore(firestore(initFirebase(projectId)));
const report = await seedDemo(store, { ownerUid, viewerUid: process.env.SEED_VIEWER_UID, githubOrganization, now: new Date() });
console.log(`Seeded ${report.written} demo records into ${projectId} (organization org_demo → GitHub ${githubOrganization}).`);
if (report.skippedNonDemo.length) console.warn(`Skipped ${report.skippedNonDemo.length} existing non-demo records: ${report.skippedNonDemo.join(", ")}`);
process.exit(0);
