# E2E Test Results

## Status
all passing

## Mode
API (NestJS + supertest against the real `AppModule` and real Postgres). The app is built in-process via `Test.createTestingModule(...).createNestApplication()`, so no separate server or port was started. No UI.

## Test command
Target check: `DATABASE_URL` unset, so the default `postgresql://flash:flash@localhost:55432/flash` applies (localhost docker Postgres, not production).
- `cd apps/api && CI=true ./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --reporter=verbose`
- Stability loop (F5): the same command (default reporter) run 15 times in a row.

## Tests added
No new tests written in this stage. The existing e2e files from the Tester and Breaker stages already cover every observable criterion, and the Fix Plans say to keep them unchanged.
- `apps/api/test/sales.e2e-spec.ts` — criteria 1–18, including the 400 matrix, 404s, 409 SOLD_OUT, SQL injection and the real-Postgres concurrency bursts (200 on stock 50, 100 on stock 1, two interleaved sales).
- `apps/api/test/sales.nul.e2e-spec.ts` — F1–F4 (NUL byte in `:id`, `name`, `buyerId`).
- `apps/api/test/sales.breaker.e2e-spec.ts` — attacks 1a/1b (NUL id → 404) and 2a/2b (NUL in body, never 500).
- `apps/api/test/app.e2e-spec.ts` — `GET /` → Hello World (criterion 19).

## Style validation
N/A — API mode.

## Coverage
| Spec item | Test |
|---|---|
| 1 create returns `{id,name,stock}` | criterion 1 |
| 2 GET returns the sale | criterion 2 |
| 3 unknown / UUID id → 404 | criterion 3 (x2), edge "abc" |
| 4 invalid POST /sales bodies → 400, no row | criterion 4 matrix (all listed bodies, plus boolean, null name, `[]`, no body) |
| 5 stock int4 max | criterion 5 |
| 6 extra fields ignored | criterion 6 |
| 7 order → 201, stock decremented | criterion 7 |
| 8 order row in DB | criterion 8 |
| 9 sold out → 409 `{error:"SOLD_OUT"}` | criterion 9 |
| 10 repeated sold-out stays 409, stock 0 | criterion 10 |
| 11 unknown sale on order route → 404, no row | criterion 11, edge "abc"/random UUID |
| 12 invalid buyerId → 400, stock unchanged | criterion 12 matrix |
| 13 invalid body + unknown sale → 400 | criterion 13 |
| 14 200 concurrent on stock 50 | criterion 14 |
| 15 100 concurrent on stock 1 | criterion 15 |
| 16 concurrent across two sales | criterion 16 |
| 17 same buyer repeatedly | criterion 17 |
| 18 SQL injection | criterion 18 |
| 19 existing `GET /` | `app.e2e-spec.ts` |
| F1 NUL id → 404 | nul F1 (x3), breaker 1a/1b |
| F2 NUL id + `{}` → 400 | nul F2 |
| F3 NUL in name → 400 | nul F3, breaker 2a |
| F4 NUL in buyerId → 400, stock unchanged | nul F4, breaker 2b |
| F5 15x stable full suite | loop below |
| Authorization | Not applicable: the spec says auth is out of scope for F01 and no guard exists |

## Prints
N/A

## Results
- Single verbose run: 4 files, 53 passed / 0 failed, 2.38 s. The full per-test list matched the files above.
- F5 stability loop: 15 consecutive runs, 0 failures (exit 0 each time, 53/53).
- No test edits were made in this stage.
- Note, not a failure: `sales.breaker.e2e-spec.ts` attacks 2a/2b still accept `[201, 400]` rather than exactly 400. Exact 400 is enforced by `sales.nul.e2e-spec.ts` F3/F4, so coverage is complete.
- No server process was started, so nothing needed killing.
