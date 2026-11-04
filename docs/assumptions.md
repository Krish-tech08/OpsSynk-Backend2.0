# Assumptions and known limitations

## Assumptions (documented product rules)

* Health weights, bands and penalties are initial product rules, not industry standards; all are configurable.
* Unlabelled bugs are weighted as medium severity (4).
* A PR is stale after 7 days without any update (comments, pushes or reviews all count as updates).
* Activity recency falls back to the repository's last push (any branch) when the default branch has no commits in the window.
* Company health averages project sub-scores; repositories not mapped to a project are ignored for scoring.
* Projects marked `completed` or `cancelled` are excluded from company health.
* Repository mapping uses repository names within the organization's GitHub account.
* Deployment status is taken only from GitHub Deployments API records; releases and workflow names are not deployment evidence.
* Workflow conclusions combine build and test jobs; individual test results are not analysed.
* Similar bugs are detected by title similarity (Jaccard ≥ 0.5) and reported only as hypotheses.

## Known limitations

* **Single instance.** The event bus, rate limiters, Gemini per-minute limiter and in-flight deduplication are in-process. Events and state are persisted, so polling still works after a restart. An investigation that was running when the process stopped is not resumed; at the next startup it is marked `failed` ("interrupted by a server restart") with a persisted terminal event.
* **No live Gemini verification here.** The Gemini integration is tested against a scripted transport. The real `@google/genai` call path is type-checked against the installed SDK, but it wasn't called during development.
* **Firestore not exercised by default tests.** The Firestore store is covered by an optional contract test that needs the emulator. The default suite uses the in-memory store.
* **GitHub deployments:** only the newest 10 deployment records are read, with statuses for up to 5 of them.
* **Pagination:** list endpoints use offset cursors over bounded result sets.
* **SSE in browsers** needs a fetch-based client, because `EventSource` can't send the Authorization header.
* **Webhooks** (push, PR, issue, workflow-run) are not implemented; data is pulled at investigation time with a short cache, and snapshots via `/github/sync`.
* **Not built:** the web dashboard UI, write-capable GitHub tools, and a GitHub App installation flow.
