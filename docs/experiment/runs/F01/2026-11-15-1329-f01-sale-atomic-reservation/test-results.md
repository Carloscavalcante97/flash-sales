# Test Results

## Status
all passing

Fix-cycle iteration 2. F5 holds: the full e2e suite went 15 for 15 green, 53/53 tests on every run. F6 holds: F1–F4, the 19 original criteria and every static check pass. The Fix Plan named no test changes, so all test files are kept unchanged.

## Test command
Target check: `DATABASE_URL` is unset in the shell. There is no `.env*` file in the repo root or in `apps/api`, and no vitest `setupFiles`/dotenv. Both `apps/api/src/prisma.ts` and `apps/api/prisma.config.ts` fall back to `postgresql://flash:***@localhost:55432/flash`, which is the local docker container `flash-sales-postgres-1` (`0.0.0.0:55432->5432`). The target is local. `prisma migrate status` reports "Database schema is up to date!" with 1 migration.

```bash
# static checks + full suites (repo root)
CI=true pnpm --filter api typecheck
CI=true pnpm --filter api lint
CI=true pnpm --filter api test
CI=true pnpm --filter api build
CI=true pnpm --filter api test:e2e

# per-file verbose run (apps/api)
CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --reporter=verbose

# F5: 15 full e2e runs in a row (apps/api, all 4 files)
for i in $(seq 1 15); do CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts; done

# control: the same 15x loop with file parallelism forced back on via the CLI (config file untouched),
# to show that the config line is what removes the flake
for i in $(seq 1 15); do CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --fileParallelism; done

# red check (HEAD worktree; node_modules symlinked; Prisma client generated inside the worktree,
# because src/generated/ is gitignored and the generator writes to ../src/generated/prisma)
RED=$(mktemp -d <scratchpad>/red.XXXX) && git worktree add --detach "$RED" HEAD
ln -s "$PWD/node_modules" "$RED/node_modules"; ln -s "$PWD/apps/api/node_modules" "$RED/apps/api/node_modules"
cp apps/api/test/sales.e2e-spec.ts apps/api/test/sales.breaker.e2e-spec.ts apps/api/test/sales.nul.e2e-spec.ts "$RED/apps/api/test/"
(cd "$RED/apps/api" && ./node_modules/.bin/prisma generate && for f in sales.e2e-spec.ts sales.breaker.e2e-spec.ts sales.nul.e2e-spec.ts; do
  CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts test/$f; done)
rm "$RED/node_modules" "$RED/apps/api/node_modules"; git worktree remove --force "$RED"
```

## Tests added
No new tests in this iteration. The Fix Plan (iteration 2) says "Changes for the Tester / E2E: None", and it lists every test file under "Do not touch". The test files added earlier in this pipeline run are kept unchanged:
- `apps/api/test/sales.e2e-spec.ts` (iteration 0): 42 HTTP e2e tests against real Postgres for criteria 1–18 and the spec's edge cases.
- `apps/api/test/sales.breaker.e2e-spec.ts` (breaker stage): 4 attacks, 1a, 1b, 2a and 2b. They are the regression tests for the iteration-1 NUL fix.
- `apps/api/test/sales.nul.e2e-spec.ts` (iteration 1): 6 exact tests for Fix Plan criteria F1–F4.

## Updated existing tests
None.

## Red check
No test file was added or changed in this iteration. The red check was re-run on HEAD for every test file added in this pipeline run, so these rows reflect current evidence.

| Test file | Fails on HEAD | How |
|---|---|---|
| `apps/api/test/sales.e2e-spec.ts` | sim (42/42 failed) | Assertion. There are no `/sales` routes at HEAD, so setup and requests get `expected 201 "Created", got 404 "Not Found"` (and `expected 400, got 404` for criterion 13). The DB-count tests also fail with `TypeError: Cannot read properties of undefined (reading 'count')`, because the HEAD Prisma client has no `sale`/`order` model. |
| `apps/api/test/sales.breaker.e2e-spec.ts` | sim (2/4 failed) | Assertion. 2a fails with `expected [ 201, 400 ] to include 404`, and 2b fails its `createSale` setup with `expected 201, got 404`. **1a and 1b pass on HEAD**: they assert 404 for `/sales/%00`, and HEAD answers 404 for every `/sales` path because the route does not exist. Iteration 1 showed that both fail with 500 on the pre-fix feature code (a HEAD worktree plus the feature files with the 4 NUL guard lines removed), which is the bug they guard. The stricter F1 tests in `sales.nul.e2e-spec.ts` add a control step that proves the route serves a real sale. |
| `apps/api/test/sales.nul.e2e-spec.ts` | sim (6/6 failed) | Assertion. F1 (x3) and F4 fail their `createSale` setup with `expected 201 "Created", got 404 "Not Found"`, and F2 and F3 fail with `expected 404 to be 400`. In iteration 1, on the pre-fix feature code, 5/6 failed with 500 (`expected 500 to be 404/400`). F2 passed there, as the plan predicts, so it guards the validation-first order rather than reproducing the bug. |
| `apps/api/vitest.config.e2e.ts` (iteration-2 fix, not a test file) | n/a | Control instead of a red check. The same 15x loop with `--fileParallelism` forced on failed **6/15** runs. Each failure was one `criterion 4` row in `sales.e2e-spec.ts`, for example `AssertionError: expected 2434 to be 2433` after the `.expect(400)` had passed. With the config as written, **0/15** runs failed. So the config line is what removes the race. |

## Static checks
| Check | Command | Exit |
|---|---|---|
| typecheck | `CI=true pnpm --filter api typecheck` (`prisma generate && tsc --noEmit`, includes `test/`) | 0 |
| lint | `CI=true pnpm --filter api lint` (`oxlint --type-aware src/ test/`) | 0 |
| full suite (unit) | `CI=true pnpm --filter api test` | 0 (1/1) |
| full suite (e2e) | `CI=true pnpm --filter api test:e2e` | 0 (4 files, 53/53) |
| build | `CI=true pnpm --filter api build` | 0 |
| F5: e2e x15 | `CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts`, 15 times in a row | 0 on 15/15 runs, 53/53 each |

## Coverage
| Spec item (criterion / edge case / security) | Test |
|---|---|
| **Fix Plan F5** full e2e suite 15x in a row, every run exit 0 and 53/53 | F5 loop: 15/15 runs exit 0, `Tests 53 passed (53)` / `Test Files 4 passed (4)` on each. The `--fileParallelism` control failed 6/15 runs |
| **Fix Plan F6** F1–F4, the 19 original criteria, typecheck, lint, test, test:e2e | All rows below pass on every run, plus Static checks |
| **Fix Plan F1** `GET /sales/%00` → 404 | `sales.nul.e2e-spec.ts` `F1: GET /sales/%00 -> 404 (not 500)`, plus breaker `attack 1a` |
| **Fix Plan F1 (edge)** an id with NUL cannot match a sale | `F1 (edge): GET /sales/<real id>%00 -> 404, a NUL-suffixed id never matches the real sale` |
| **Fix Plan F1** `POST /sales/%00/orders {"buyerId":"b1"}` → 404, no order row | `F1: POST /sales/%00/orders {"buyerId":"b1"} -> 404 and no order row created`, plus breaker `attack 1b` |
| **Fix Plan F2** `POST /sales/%00/orders {}` → 400 | `F2: POST /sales/%00/orders with {} -> 400 (validation before the lookup)` |
| **Fix Plan F3** NUL in `name` → 400, no new `sales` row | `F3: POST /sales with a NUL inside name -> 400 and no new row in sales`, plus breaker `attack 2a` |
| **Fix Plan F4** NUL in `buyerId` on stock 1 → 400, stock 1, no order row | `F4: POST /sales/:id/orders {"buyerId":"a\u0000b"} on stock 1 -> 400, stock stays 1, no order row`, plus breaker `attack 2b` |
| C1 POST /sales Tênis/10 → 201 `{id,name,stock}`, no other keys | `criterion 1: POST /sales {"name":"Tênis","stock":10} -> 201 { id, name, stock } with no other keys` |
| C2 GET /sales/:id → 200 `{id,name:"Tênis",stock:10}` | `criterion 2: GET /sales/:id with the created id -> 200 { id, name: "Tênis", stock: 10 }` |
| C3 GET /sales/does-not-exist → 404 | `criterion 3: GET /sales/does-not-exist -> 404 (not 500)` |
| C3 GET /sales/<random UUID> → 404 | `criterion 3: GET /sales/<random UUID> -> 404 (not 500)` |
| C4 POST /sales 400 for each listed body, no new `sales` row | `criterion 4: POST /sales with %s -> 400 and no row in sales` (`it.each`, global `prisma.sale.count()` before = after). No longer flaky: 15/15 green |
| C4 empty request with no body → 400, no row | `criterion 4: POST /sales with an empty request (no body) -> 400 and no row in sales` |
| C5 stock 2147483647 → 201 | `criterion 5: POST /sales {"name":"x","stock":2147483647} -> 201 with stock 2147483647` |
| C6 extra `id`/`extra` ignored, not echoed or stored | `criterion 6: extra fields { id: "forced", extra: 1 } -> 201, id is not "forced", no extra key echoed or stored` |
| C7 order on stock 2 → 201 `{orderId,status:"RESERVED"}`, GET stock 1 | `criterion 7: order on stock 2 -> 201 { orderId, status: "RESERVED" } and GET shows stock 1` |
| C8 exactly one `orders` row `{id,saleId,buyerId:"b1",status:"RESERVED"}` | `criterion 8: the orders table has exactly one row { id: orderId, saleId, buyerId: "b1", status: "RESERVED" }` |
| C9 stock 1: 201 then 409 `{error:"SOLD_OUT"}`, stock 0, 1 order row | `criterion 9: stock 1 -> first order 201, second 409 { error: "SOLD_OUT" }, stock 0, exactly 1 order row` |
| C10 repeated sold-out orders keep 409, stock 0, no new rows | `criterion 10: repeated orders on a sold-out sale keep returning 409, stock stays 0, no new order rows` |
| C11 POST /sales/does-not-exist/orders → 404, no order row | `criterion 11: POST /sales/does-not-exist/orders {"buyerId":"b1"} -> 404 and no order row created` (global `prisma.order.count()`, now serialized across files) |
| C12 order 400 for `{}`, `""`, `"   "`, `123`, `null`; stock unchanged | `criterion 12: order with %s -> 400, stock unchanged, no order row` (`it.each`) |
| C12 order with empty request (no body) → 400 | `criterion 12: order with an empty request (no body) -> 400, stock unchanged, no order row` |
| C13 does-not-exist + `{}` → 400 | `criterion 13: POST /sales/does-not-exist/orders with {} -> 400 (validation before lookup)` |
| C14 200 concurrent on stock 50 → 50×201 distinct, 150×409, stock 0, 50 rows | `criterion 14: 200 concurrent orders on stock 50 -> ...` |
| C15 100 concurrent on stock 1 → 1×201, 99×409, stock 0 | `criterion 15: 100 concurrent orders on stock 1 -> exactly 1 x 201, 99 x 409, stock 0` |
| C16 interleaved 30+30 on two stock-5 sales → 5 orders each, stock 0 | `criterion 16: 30 interleaved concurrent orders on each of sale A (stock 5) and sale B (stock 5) -> 5 orders each, stock 0` |
| C17 same buyerId: 201, 201, 409 | `criterion 17: the same buyerId reserves repeatedly while stock lasts (201, 201, then 409)` |
| C18 SQL-injection buyerId → 201, stored verbatim, `orders` exists | `criterion 18: SQL-injection buyerId -> 201, stored verbatim, orders table still exists` |
| C19 existing `GET /` e2e + typecheck/lint/test pass | `test/app.e2e-spec.ts` passes in every e2e run. See Static checks |
| Edge: stock boolean → 400 | `criterion 4: POST /sales with stock true (boolean) -> 400 and no row in sales` |
| Edge: name `null` → 400 | `criterion 4: POST /sales with name null -> 400 and no row in sales` |
| Edge: non-object JSON body `[]` → 400 (both routes) | `criterion 4: POST /sales with non-object JSON body [] -> ...` and `criterion 12: order with non-object JSON body [] -> ...` |
| Edge: malformed JSON → 400 | NOT COVERED: the spec says Nest's built-in body parser already rejects it and no handling should be added, so there is no product code to test |
| Edge: non-UUID `:id` → 404, never 500 (GET), including NUL | `edge case: arbitrary non-UUID :id ("abc") on GET -> 404, never 500`, plus F1 GET and F1 edge |
| Edge: non-UUID / random UUID `:id` on order route → 404, no side effects | `edge case: non-UUID :id ("abc") and a random UUID on the order route -> 404, never 500, no order row`, plus F1 POST |
| Edge: sold-out exact body, stock exactly 0, no orphan row | criteria 9 and 10 |
| Edge: invalid body + unknown sale → 400 | criterion 13 and F2 |
| Edge: concurrent bursts N > E, E = 1, two sales | criteria 14, 15, 16 |
| Edge: repeat orders by same buyer allowed | criterion 17 |
| Edge: extra fields cannot override `id` and are not echoed | criterion 6 |
| Spec rule: `name` stored as received, no trimming | `spec rule: name is stored as received, without trimming` |
| Security: anyone may call, no guard | Every test calls without an `Authorization` header |
| Security: validation before DB access | criteria 4, 12, 13, plus F2, F3 and F4 (no row written, stock unchanged) |
| Security: SQL injection / only bound parameters | criterion 18 |
| Security: data leaving the system | `toStrictEqual` in criteria 1, 2, 5, 6, 7, 9, 10, 14, 15, 17 |
| Security: Prisma/pg error details don't reach clients | F1, F3 and F4 prove the NUL paths never reach Postgres (no 500). A forced DB failure in general is NOT COVERED: it would need a mocked Prisma inside an e2e, and the spec treats it as a framework guarantee |
| Security: integrity invariant (stock ≥ 0, orders ≤ initial stock) | criteria 9, 10, 14, 15, 16, plus F4 (a rejected order doesn't consume a unit) |
| Security: size limits, secrets/config, rate limiting, logging | n/a / framework default per spec |

## Results
Working tree, `CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --reporter=verbose` (exit 0):
```
test/app.e2e-spec.ts            passed=1  failed=0 skipped=0
test/sales.e2e-spec.ts          passed=42 failed=0 skipped=0
test/sales.breaker.e2e-spec.ts  passed=4  failed=0 skipped=0
test/sales.nul.e2e-spec.ts      passed=6  failed=0 skipped=0
 Test Files  4 passed (4)
      Tests  53 passed (53)
   Duration  2.41s
```
Unit: `Test Files 1 passed (1)`, `Tests 1 passed (1)`. 0 skipped and 0 todo. A grep of `apps/api/test/*.ts` finds no `.skip(`, `.only(`, `.todo(`, `toMatchSnapshot`, `expect.soft` or `test.fixme`.

F5 loop, 15 consecutive full e2e runs, all 4 files:
```
run 1..15  exit=0  Tests 53 passed (53) | Test Files 4 passed (4)   (every run)
failed runs: 0/15
```

Control, the same loop with `--fileParallelism` (parallel files, as before the fix):
```
failed runs: 6/15 (runs 1, 4, 5, 6, 7, 13), each with 1 failed | 52 passed
FAIL test/sales.e2e-spec.ts > ... > criterion 4: POST /sales with stock 0 -> 400 and no row in sales
AssertionError: expected 2434 to be 2433 // Object.is equality
```
This is the same signature the iteration-1 report recorded, and it is gone with `fileParallelism: false`. That confirms the Fix Plan's root cause: the failures came from running test files in parallel, and the product had no defect.

No failures.

Side effect: the tests leave sale and order rows in the local docker DB, as in earlier iterations. Each test creates its own sale, and the spec says no cleanup is needed.
