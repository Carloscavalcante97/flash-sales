# Build

## Status
implemented

## Criteria
| # | criterion (from spec) | test |
|---|---|---|
| 1 | No header: F01 behavior unchanged | existing `test/sales.e2e-spec.ts`, `sales.nul`, `sales.breaker` (all green) |
| 2 | Invalid key (empty, 256 chars, space, tab, non-ASCII) → 400, no order, stock unchanged | `criterion 2` ×5 |
| 3 | Valid key: 1 char, 255 chars, every char 0x21–0x7E → accepted and bound | `criterion 3` ×3 |
| 4 | First keyed request processed as in F01 (201 body, stock −1, one row), 201 stored | `criterion 4` |
| 5 | Same key + sale + buyer after 201 → same status and byte-identical body, no order, stock unchanged | `criterion 5` |
| 6 | 409 SOLD_OUT stored; replay returns it even after stock is refilled, no order | `criterion 6` |
| 7 | Same key, other sale → 422 IDEMPOTENCY_KEY_REUSED, no order | `criterion 7` |
| 8 | Same key, other buyerId → 422, no order (after a 201 and after a stored 409) | `criterion 8` ×3 (incl. fix 1) |
| 9 | 404 not stored: the key stays free for another sale | `criterion 9` |
| 10 | 400 not stored: the key stays free for another buyer | `criterion 10` |
| 11 | Concurrent same key → ≤1 order, each 201 with the same orderId or 409 IN_PROGRESS, stock −1 | `criterion 11` (30 parallel) |
| 12 | Rule: never two orders per key, stock −1 at most per key (10 keys × 5 parallel, stock 3) | `criterion 12` |
| 13 | Rule: Postgres via Prisma, no Redis, no `@nestjs/idempotency` | inspection: package.json unchanged |

All tests are in `apps/api/test/sales.idempotency.e2e-spec.ts`.

## Red check
`npx vitest run --config ./vitest.config.e2e.ts test/sales.idempotency.e2e-spec.ts` → 18/18 new tests failed before implementation (criterion 4 passed on the first run because F01 already returns that shape. I rewrote it to also assert the "201 is stored" half of its spec sentence, and it failed after that). Criterion 1 is a no-change criterion, so it is covered by the existing F01 suite and can't be red by nature.

## Checks
| check | command | exit |
|---|---|---|
| typecheck | `CI=true pnpm typecheck` (root) | 0 |
| lint | `CI=true pnpm lint` (root; 0 warnings) | 0 |
| unit tests | `CI=true pnpm test` (root) | 0 |
| build | `CI=true pnpm build` (root) | 0 |
| e2e suite | `CI=true pnpm test:e2e` (apps/api; 5 files, 71 tests) | 0 |
| new tests ×3 | `npx vitest run --config ./vitest.config.e2e.ts test/sales.idempotency.e2e-spec.ts` | 0 0 0 |

## Files
- `apps/api/prisma/schema.prisma`: `IdempotencyKey` model (`idempotency_keys`: key PK, saleId, buyerId, status Int?, body `@db.Json`)
- `apps/api/prisma/migrations/20261115171227_f02_idempotency_keys/migration.sql`: creates the table (applied to the local DB)
- `apps/api/src/sales.service.ts`: `reserve()` takes an optional tx client; new `reserveOnce()` (claim + reserve + store in one transaction)
- `apps/api/src/sales.controller.ts`: reads `Idempotency-Key`, validates `^[\x21-\x7E]{1,255}$`, replays the stored status/body
- `apps/api/test/sales.idempotency.e2e-spec.ts`: 19 e2e tests, criteria 2–12

## Map
- Flow: controller validates buyerId (F01), then the key. No header goes to `reserve()` (F01 path, untouched SQL). With a header it goes to `reserveOnce()`.
- `reserveOnce`: `$transaction` → `INSERT .. ON CONFLICT ("key") DO NOTHING`. If claimed: F01 reserve on `tx`, then store 201/409; a 404 throws and rolls the claim back. If not claimed: load the row, 422 on a mismatch, otherwise replay.
- Tests: `cd apps/api && CI=true pnpm test:e2e` (all) or the single-file command above. Real Postgres, files run serially.
- App: `cd apps/api && pnpm start` → port 3000 (`PORT`). DB: `DATABASE_URL`, default `postgresql://flash:flash@localhost:55432/flash` (docker compose).
- Migration: `cd apps/api && npx prisma migrate deploy` (already applied locally), then `npx prisma generate`.

## Notes
- Concurrent same-key requests block on the key's PK until the first one commits, then replay it. So `IDEMPOTENCY_IN_PROGRESS` is never returned, which the spec allows ("201 … ou 409"). Probe, not kept: 600 parallel same-key requests gave 600 × 201 with one orderId in ~4 s. 600 distinct keys on one sale took about the same time, with no 500s. Ceiling: each waiter holds a pool connection (ponytail comment in code).
- Precedence: a used key wins over 404, so key K reused on a missing sale (or `:id` containing NUL) gives 422. A free key on a missing or NUL sale gives 404 and is not stored.
- `body` is `json` rather than `jsonb`, so the replayed body is byte-identical (jsonb would reorder `orderId`/`status`).
- The 1-char key test deletes key `~` first, because a 1-char key can't be unique across runs.
- `reserve()`'s 404 lookup moved from `this.findOne` to `db.sale.findUnique` so it runs inside the tx. Behavior is the same.
- 0x7F and other control characters can't be sent by Node's HTTP client, so they aren't tested. The regex rejects them.
- Prettier: existing files already fail `prettier --check` and there is no format-check script, so I didn't apply it.

## Fix (iteration 1)
- Attack 2 (bug), `apps/api/src/sales.service.ts`: pg stores a lone surrogate as U+FFFD, so the read-back buyerId never matched. `reserveOnce` now stores and compares `JSON.stringify(buyerId)`, which is lossless: `"b\ud800"` replays, and a different `"b�"` still gets 422. Keyed path only: F01 `reserve()` and its SQL are unchanged. No migration (text column), just a comment in `schema.prisma`.
- Attack 3 (Decision), same file: `$transaction(..., { maxWait: 2**31-1, timeout: 2**31-1 })` uses the largest setTimeout delay (Prisma rejects 0 and Infinity overflows to 1 ms), so a keyed request waits on a locked sale like F01.
- Test added: `test/sales.idempotency.e2e-spec.ts` "criterion 8 (fix 1)" (`"b\ud800"` then `"b�"` → 422). It was red before the fix (got 201). Breaker attacks 2 and 3 were red before and pass now; I didn't change them.
- Checks: typecheck, lint, unit and build exit 0. `pnpm test:e2e`: 6 files, 74 tests, exit 0. Idempotency + breaker files ×3: 0 0 0.
- Note: key rows written before this fix (local test data only) hold the raw buyerId, so replaying them would now give 422.
