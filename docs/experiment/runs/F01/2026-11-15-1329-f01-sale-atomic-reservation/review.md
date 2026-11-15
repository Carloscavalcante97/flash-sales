# Review

## Verdict
SHIP

## Rationale
- **Request conformance.** The diff implements the request's contract exactly:
  - `POST /sales` returns 201 `{id,name,stock}` or 400.
  - `GET /sales/:id` returns 200 with the current available stock, or 404.
  - `POST /sales/:id/orders` returns 201 `{orderId,status:"RESERVED"}`, 409 with exactly `{"error":"SOLD_OUT"}`, 404, or 400.
  - Each order reserves 1 unit, the data is in Postgres via the existing `PrismaService`, and there is no Redis.
  - The spec adds some 400 cases the request doesn't list: an int4 upper bound on `stock`, blank `name`/`buyerId`, and NUL. These sit inside the request's "400 se o payload for inválido", so they are not drift. The NUL rule went through the human gate ("Human gate: the spec gap was accepted", `.pipeline/changes.md`).
  - Payment, expiry, idempotency and auth are all absent, as the request requires.
- **Spec conformance (diff, not prose).**
  - `apps/api/src/sales.service.ts:26-33` is the spec's single-statement CTE via tagged-template `$executeRaw`, unchanged. The `UPDATE ... WHERE stock > 0` inside a data-modifying CTE is atomic under READ COMMITTED, so stock cannot go negative. The sold-out path calls `findOne` only after the statement, so the response is 404 for an unknown sale and 409 otherwise.
  - There is no `$executeRawUnsafe`, `Prisma.raw` or string-built SQL.
  - In `apps/api/src/sales.controller.ts`, validation runs before any service call and reads only `name`, `stock` and `buyerId`.
  - `main.ts` is untouched, and there is no global pipe or filter, no logging and no new dependency.
  - The schema matches the spec verbatim (`text` ids, no timestamps). The migration is generated and contains `"status" "OrderStatus" NOT NULL DEFAULT 'RESERVED'`.
  - `app.module.ts` only registers the two new classes.
  - Scope: `.pipeline/baseline.txt` is empty and `scope-before.txt` equals `scope-after.txt`. No file outside the planned list changed.
- **Fix loop.**
  - Fix Plan 1: both breaker `BROKE` rows are resolved. The NUL guards are at `sales.service.ts:14,21` and `sales.controller.ts:13,30`, all written as `'\u0000'`, with no try/catch on Prisma codes and the CTE untouched.
  - Fix Plan 2 is the single `fileParallelism: false` line in `apps/api/vitest.config.e2e.ts:9`. The Tester's control (6/15 failures with `--fileParallelism`, 0/15 without) shows the flake was test isolation, not the product.
- **Security.**
  - Auth is absent by explicit request, an accepted gap.
  - Injection is closed because every value is a bound parameter, and criterion 18 proves it end to end with a `to_regclass` check.
  - No new secrets or logging.
  - Error bodies are Nest defaults or the exact SOLD_OUT object.
  - I checked the installed `router@2.2.0` `decodeParam`: a malformed percent-encoded `:id` such as `%FF` raises a URIError with `status = 400`, so it gives 400, not 500. NUL was the only `:id` string that could reach Postgres and fail, and it is now guarded.
- **Test quality.**
  - I read all three test files. Expected values are spec literals. Response shapes use `toStrictEqual`. DB rows are asserted directly (criterion 8 deep-equals the row, criterion 14 matches DB order ids to response ids).
  - The concurrency tests (200 orders on stock 50, 100 on stock 1, 30+30 interleaved) run against real Postgres and account for every response.
  - There are no mocks and no snapshot, skip, only, todo, soft or lone `toBeDefined` assertions.
  - The 404 tests include a control step proving the route serves a real sale.
  - Every acceptance criterion, F1–F5 and every Security item appears in a Coverage table. I accept the two NOT COVERED rows: malformed JSON, and a forced generic DB failure. The spec defines both as framework guarantees and forbids adding code for them.
  - Red check: all three files fail on HEAD. Static checks (typecheck, lint, build, test, test:e2e) all exit 0, with 53/53 tests and 0 skipped.
- **E2E.** Status is all passing, in API mode, with no prints and no `.pipeline/review/` directory.
- **Unverified.** I could not run anything in this read-only stage. The green runs are as reported by the Tester and E2E stages; my own check was the code reading above.

## Findings
- [minor] `apps/api/test/sales.breaker.e2e-spec.ts:34-56` — duplicates `sales.nul.e2e-spec.ts` with weaker assertions:
  - 1a and 1b have no control step, so they also pass on HEAD, where the route doesn't exist.
  - 2a and 2b still accept `[201, 400]`, although the accepted requirement is exactly 400.
  - Every case is covered more strictly by nul F1, F3 and F4. Two regression files for one fix is redundant (ponytail: about 57 lines that could be deleted).
- [minor] `apps/api/test/sales.e2e-spec.ts:100-104, 108-112, 196-200, 205-210` — the "no new row" checks for criteria 4 and 11 compare global `count()`s. That is why the run needed `fileParallelism: false`. They will still flake if anything else writes to the same local DB during a run, such as a `start:dev` server on 55432. A count scoped to a unique marker, as nul F3 does at `sales.nul.e2e-spec.ts:79-87`, would make them robust and leave the config line optional.
- [minor] Process: Fix Plan iteration 1 said "Changes for the Tester / E2E: None", yet `apps/api/test/sales.nul.e2e-spec.ts` was added anyway. That file introduced the cross-file race that iteration 2 then had to fix. The file itself is better than the breaker file it duplicates, so this is a note, not a defect.

## Required before merge
None.

Relevant files:
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/src/sales.service.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/src/sales.controller.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/src/app.module.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/prisma/schema.prisma
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/prisma/migrations/20261115155150_f01_sales_orders/migration.sql
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/prisma/migrations/migration_lock.toml
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/vitest.config.e2e.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/test/sales.e2e-spec.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/test/sales.nul.e2e-spec.ts
- /Users/antonio/Documents/personal-projects/flash-sales/apps/api/test/sales.breaker.e2e-spec.ts

Note: the `security-review` skill could not load because this repo has no `origin/HEAD` (its preamble runs `git diff origin/HEAD...`). I applied its checklist by hand to the working-tree diff.
