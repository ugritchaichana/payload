# Test pipeline work on this fork

This fork of [payloadcms/payload](https://github.com/payloadcms/payload) is a personal research project: make the existing CI test pipeline faster, cheaper and never wrong, and prove every claim with measured runs. Nothing here is sent upstream. Status: paused 2026-10-19 (Milestone 1 under verification).

## Rules of the work
- Only pipeline and test configuration change (workflows, composite actions, path filters, the gate, service start, caches, sharding, Playwright and vitest config). Test logic and product code never change, so per-test results before and after stay comparable.
- Every claim is measured on this fork: an A/A baseline first, then at least 10 runs per arm on the same commit tree, compared with a Mann-Whitney test against the measured noise. Proportions such as red rates need at least 100 runs per arm and are reported with a 95% confidence interval until then.
- Correctness comes before speed and cost: a change that makes a number better while any test silently stops running is rejected.
- Every check is shown red before it is shown green.

## Baseline

Upstream CI (`.github/workflows/main.yml`, read-only study of 100 push and 100 pull-request runs, 2026-10-06 to 10-16, reference commit 73d3dd8): 283 jobs per full run; job-seconds median 77,369; wall median 1,128 s; setup (service start, Node setup, cache restore) is 45.5% of job-seconds; 46 of 100 main runs red at the first attempt, 8 of them from a deterministic defect.

This fork, A/A (pull request #1, tree of 73d3dd8, 10 attempts after one warm-up, GitHub-hosted `ubuntu-26.04` 4 CPU / 16 GB, up to 40 concurrent jobs; `Content API Tests` excluded because it needs upstream's cloud credentials):

| Metric | Median | Range | CV |
|---|---|---|---|
| job-seconds | 75,055 | 73,898-76,327 | 1.15% |
| list-price cost per run | $8.30 | $8.17-$8.42 | 1.12% |
| wall | 2,328.5 s | 2,212-2,725 s | 6.05% |
| red attempts on identical code | 8 of 10 | | |

All 8 red attempts came from E2E legs whose tests failed every in-job retry; `E2E - a11y [tanstack-start]` failed in 6 of 10.

## What is wrong today (measured)
- False green: the `All Green` gate fails only on `failure` or `cancelled` of the jobs it lists, and it does not list `e2e-prep` or the matrix jobs. Upstream run 38782485782 attempt 1: E2E Prep failed, every E2E job was skipped, All Green succeeded.
- Tests no job runs: 77 spec files are reachable by no CI job (for example several suites missing from `.github/workflows/e2e.config.ts`).
- Path-filter holes: changes to `.tool-versions`, `tools/**`, `scripts/**`, the matrix configs and `.github/actions/*` can skip tests whose outcome they change.
- Hidden flakiness: Playwright retries (5 on Next, 2 on TanStack) hide a median of 27 flaky tests per green main run; nothing reports them.
- A committed `.only` would pass CI (no `forbidOnly`).

## Targets (frozen on the fork baseline)

| Axis | Metric | Commit | Stretch |
|---|---|---|---|
| Never wrong | per-test results before vs after | identical | |
| Never wrong | known false-green paths, unexplained unreachable specs, path-filter holes, silent flakes | 0 each | |
| Never wrong | main red caused by infra / by flakiness | <= 3% / <= 8% | <= 1% / <= 3% |
| Cheaper | job-seconds per full run | <= 63,800 (-15%) | <= 48,800 (-35%) |
| Cheaper | list-price cost per run | <= $7.06 | <= $5.40 |
| Faster | wall on this fork | <= 1,956 s (-16%) | <= 1,537 s (-34%) |

## Milestones
1. Never wrong (branch `m1b/flaky-policy`, pull request #2): gate fails when a selected job is skipped or a matrix/prep job fails; `forbidOnly` in CI; a reachability check (every spec runs in a job or is listed with a reason); path filters for files that change outcomes; every pass-after-retry reported; failed tests retried once on a fresh runner (test failures only, never infra; a run with more than 3 failing legs is treated as systemic); a data-based quarantine (22 tests flaky in at least 25% of green runs) that still runs every time, does not gate, and expires after 30 days. Local: 245 script tests pass; CI verification and the red-first branches are next.
2. Cheaper: start only the services a suite uses, drop the unused pnpm-store restore, cache Node setup, stop template jobs rebuilding everything.
3. Faster: overlap build and E2E prep, split the long poles, balance shards by measured duration.
4. Elastic pool: run a fixed subset of this pipeline on a self-hosted Kubernetes pool and keep its CPU busy (idle under 1% while work waits).

## Branches and pull requests on this fork
- `aa-base` (parent of 73d3dd8) and `aa-baseline` (tree of 73d3dd8): pull request #1, the A/A baseline.
- `m1b/flaky-policy`: pull request #2, Milestone 1.
- Workflows other than `main.yml` are disabled on this fork.
