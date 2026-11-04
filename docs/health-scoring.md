# Health scoring

All scores are calculated by deterministic code in `src/domain/health/` and never by Gemini. Every constant
lives in `HealthConfig` (`src/domain/health/health.config.ts`). You can override it with a JSON file at
`HEALTH_CONFIG_PATH`; it is deep-merged and validated (weights must sum to 1, `bands.warning` < `bands.healthy`).

## Rules that apply to every score

* Every sub-score is **0–100**, or **`null` when the signal is unavailable**, with a `reason`. Unknown is never scored as 0.
* `combine()` drops unavailable sub-scores and **renormalizes** the remaining weights.
* **Coverage** is the share of the total weight that had data. If coverage is below `minimumCoverage` (default 0.5),
  the status is **`insufficient_data`** and the score is `null`.
* Status bands (configurable product rules, not industry standards): **healthy ≥ 80**, **warning ≥ 50**, **critical < 50**.
* Every response includes `coverage`, `missingSignals`, `appliedWeights` and each sub-score's `inputs`, so the UI can explain a score.

## Weights (default)

| Category | Weight | Source |
|---|---|---|
| Project delivery | 0.30 | Firestore tasks and project dates |
| CI/CD | 0.25 | GitHub Actions workflow runs |
| Bugs | 0.20 | Open GitHub issues labelled as bugs (PRs excluded) |
| Pull requests | 0.15 | Open GitHub pull requests |
| Repository activity | 0.10 | Default-branch commits, last push |

## Sub-score formulas

### Delivery
```
delivery = 100 − overduePenalty·(overdue / total) − blockedPenalty·(blocked / total) − scheduleGapPenalty·max(0, expected − completion)
```
* `completion = done / total` (task states only). `overdue` = open tasks past their due date.
* `expected = (now − startDate) / (dueDate − startDate)`, clamped to 0–1.
* Defaults: overduePenalty 60, blockedPenalty 30, scheduleGapPenalty 50.
* **Missing data:** no tasks → `null`. Missing project start or due date → schedule term omitted, and `reason` says so.
* Example: 5 tasks, 2 done, 1 overdue, 1 blocked, expected 0.8 → 100 − 12 − 6 − 20 = **62**.

### CI
```
ci = 100·successRate − min(maxConsecutiveFailurePenalty, consecutiveFailurePenalty·max(0, consecutiveFailures − 1))
```
* Uses completed runs in the last `windows.ciDays` (14) days on the **default branch**. If the default branch has none, all branches are used and `branchScope` says so.
* Success conclusions: `success`. Failure conclusions: `failure`, `timed_out`, `startup_failure`. Cancelled, skipped, neutral and in-progress runs are excluded.
* Defaults: 10 per consecutive failure beyond the first, capped at 30.
* **Missing data:** runs not retrievable, or no completed runs in the window → `null`. A repository without CI is "unknown", not "failing".
* Multiple repositories: the mean of the available repository scores.
* Example: 7 of 10 passed and the latest 3 failed → 70 − 20 = **50**.

### Bugs
```
bugs = 100 − Σ (open bugs × severity weight)
```
* A bug is an open issue with a label in `bugs.bugLabels` (`bug`, `type:bug`, …). Pull requests are always excluded.
* Severity comes from labels such as `severity:critical`, `p0` or `sev1`. Weights: critical 25, high 10, medium 4, low 1, **unclassified 4** (an assumption: unlabelled bugs count as medium).
* **Missing data:** issues not retrievable → `null`. **Zero open bugs → 100**, because the signal was retrieved.
* Multiple repositories: counts are pooled before scoring.

### Pull requests
```
pullRequests = 100 − staleRatioPenalty·(stale / open) − perStalePrPenalty·stale
```
* Draft PRs are ignored. A PR is **stale** when it has had no update for ≥ `windows.stalePrDays` (7) days.
* Defaults: staleRatioPenalty 60, perStalePrPenalty 8.
* **Missing data:** PRs not retrievable → `null`. No open PRs → 100. Multiple repositories: pooled.
* Example: 3 open, 2 stale → 100 − 40 − 16 = **44**.

### Activity
```
activity = recencyWeight·recency + (1 − recencyWeight)·volume
recency  = 100 if days ≤ fullScoreWithinDays; 0 if days ≥ zeroScoreAfterDays; linear in between
volume   = min(100, 100·commitsInWindow / commitsForFullVolume)
```
* Defaults: recencyWeight 0.6, fullScoreWithinDays 3, zeroScoreAfterDays 30, commitsForFullVolume 10, window 14 days.
* "Days" is measured from the latest default-branch commit in the window. If there is none, the repository's last push (`pushed_at`, any branch) is used and labelled `lastActivitySource: "pushed_at"`.
* **Missing data:** commits not retrievable → `null`. No activity ever recorded → `null`. Multiple repositories: mean.

## Project and company aggregation

* **Project health** combines the five sub-scores of the project and its mapped repositories. A project with no mapped
  repositories has only delivery data, so its coverage is 0.30, which is below 0.5 → `insufficient_data`.
* **Company health**: for each category, the mean of the project sub-scores that are available; then the same weighted
  combination. Projects with status `completed` or `cancelled` are excluded and listed in `excludedProjects`.
  Repositories not mapped to any project don't affect the company score.

## Demo dataset results (fixture mode)

| Profile | Example project | Score | Status |
|---|---|---|---|
| healthy | Android App | ≈ 98.8 | healthy |
| warning | iOS App | ≈ 60 | warning |
| critical | Payments SDK | ≈ 11.6 | critical |

The company score for the demo organization is about 64 (warning: 5 healthy, 4 warning, 3 critical projects).
These counts are asserted by the automated tests.
