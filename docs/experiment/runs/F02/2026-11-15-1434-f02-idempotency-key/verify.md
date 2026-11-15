# Verify

## Verdict
SHIP

## Attacks
| # | attack | test | result | kind |
|---|---|---|---|---|
| 1 | Flash-sale burst on the running API (PORT=3998): 1000 keys x 2 concurrent copies (2000 requests), stock 200 | removed | held: no 5xx, 200 orders, at most 1 orderId per key, stock 0 | - |
| 2 | Property test: identical retry with 61 generated buyerIds (emoji, combining marks, RTL, U+FFFF, lone surrogates, 50k chars) | `apps/api/test/sales.idempotency.breaker.e2e-spec.ts` "attack 2" | BROKE in pass 1 (43/61 got 422). Fixed in iteration 1, now passes | bug, fixed |
| 3 | Sale row locked by another DB session for 7 s while a keyed and an unkeyed (F01) request arrive | same file, "attack 3" | BROKE in pass 1 (keyed got 500, P2028). Fixed in iteration 1 per the Decision, now 201 like F01 | spec gap, decided and fixed |

## Findings
None.

Recheck of fix iteration 1 (`apps/api/src/sales.service.ts`, comment in `apps/api/prisma/schema.prisma`):
- Attack 2: `reserveOnce` now stores and compares `JSON.stringify(buyerId)`. Lone surrogates are escaped, so the stored value is lossless. The identical retry `"b\ud800"` replays 201. The different buyer `"b�"` gets 422, covered by the new test "criterion 8 (fix 1)", which passes. The F01 `reserve()` path and its SQL are unchanged.
- Attack 3: `$transaction(..., { maxWait: 2**31-1, timeout: 2**31-1 })`. The keyed request now waits out the lock and returns 201. The retry replays, and stock is decremented exactly once.
- Did the long timeout add a new risk? I probed it two ways and found none.
  - Leaked timer: an in-process `reserveOnce` followed by `app.close()` exited at once. No 24-day timer is left holding the process open.
  - Pool starvation: I locked sale A for 6 s, sent 12 requests to it, and timed `GET /sales/<other>`. Unkeyed (F01): other sale 200 after 6023 ms, all 12 got 201. Keyed: 200 after 6025 ms, all 12 got 201. The behaviour is the same as F01. With the default pool of 10, requests stuck behind a locked sale stall unrelated requests, but that happens in F01 too and does not come from this fix. The old 5 s timeout never released the connection anyway, because the query was still running on it.
- Checks re-run: typecheck 0, lint 0, unit 0, build 0. `pnpm test:e2e`: 6 files, 74/74 pass, including breaker attacks 2 and 3.

## Failures
None.

## Spec gaps
None. Attack 3 is settled by the line in `## Decisions`: keyed requests wait like F01.
