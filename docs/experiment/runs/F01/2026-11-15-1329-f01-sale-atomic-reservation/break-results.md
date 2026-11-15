# Break Results

## Status
BROKE

Target check: `DATABASE_URL` unset → default `postgresql://flash:flash@localhost:55432/flash` (apps/api/src/prisma.ts), localhost docker-compose Postgres.

Command: `cd apps/api && CI=true npx vitest run --config ./vitest.config.e2e.ts test/sales.breaker.e2e-spec.ts` → `Tests 4 failed (4)`, exit 1.
The breaker file matches the e2e include (`**/*.e2e-spec.ts`), so `pnpm --filter api test:e2e` fails while these bugs are open. `tsc --noEmit` and `oxlint --type-aware` on the file: exit 0.

## Attacks
| # | Attack | Test | Result | Kind |
|---|---|---|---|---|
| 1 | NUL byte as `:id`: `GET /sales/%00` and `POST /sales/%00/orders {"buyerId":"b1"}` | `apps/api/test/sales.breaker.e2e-spec.ts::attack 1a: GET /sales/%00 (NUL byte as :id) -> 404`, `::attack 1b: POST /sales/%00/orders {"buyerId":"b1"} -> 404` | BROKE (500 on both) | bug |
| 2 | NUL byte inside a body string that passes the spec's validation: `POST /sales {"name":"a\u0000b","stock":1}` and `POST /sales/:id/orders {"buyerId":"a\u0000b"}` | `apps/api/test/sales.breaker.e2e-spec.ts::attack 2a: POST /sales with a NUL byte inside name -> 201 or 400, never 500`, `::attack 2b: POST /sales/:id/orders with a NUL byte inside buyerId -> 201 or 400, never 500; no unit lost` | BROKE (500 on both; stock integrity held) | spec gap |
| 3 | Two app instances (2 replicas, separate Prisma pools) racing on one sale: stock 20, 120 orders interleaved across both | (deleted) | held: exactly 20×201, 100×409, 20 order rows, stock 0 | — |

## Failures

### 1. NUL byte in `:id` → 500 instead of 404 (bug)
- **Done:** `GET /sales/%00`; `POST /sales/%00/orders` with `{"buyerId":"b1"}`. Express decodes the param to `"\u0000"`.
- **Expected:** 404 on both. Spec, Prisma schema notes: "Any string in `:id` must yield a clean 404". Edge cases: "Arbitrary non-UUID strings as `:id` → 404, never 500" and "An unknown sale on the order route: 404 with no side effects".
- **Happened:** 500 on both. The id goes to Postgres as a bound `text` parameter, and Postgres rejects 0x00 in text (`22021`) before it runs the lookup. GET fails in `findOne` → `prisma.sale.findUnique`. POST fails in `reserve` → `$executeRaw`. Nest's default handler turns the Prisma error into 500 (body `{"statusCode":500,"message":"Internal server error"}`, no pg detail leaked). Nothing was written.
- **Error output:**
```
AssertionError: expected 500 to be 404 // Object.is equality
 ❯ test/sales.breaker.e2e-spec.ts:36:24   (1a)
 ❯ test/sales.breaker.e2e-spec.ts:41:24   (1b)

[ExceptionsHandler] PrismaClientKnownRequestError:
Invalid `this.prisma.sale.findUnique()` invocation in apps/api/src/sales.service.ts:14:41
Database error. Code: `22021`. Message: `invalid byte sequence for encoding "UTF8": 0x00`

Invalid `prisma.$executeRaw()` invocation:
Raw query failed. Code: `22021`. Message: `invalid byte sequence for encoding "UTF8": 0x00`
```
- Note: any client can trigger this (no auth in F01), and each call logs an ERROR with a stack trace. Repeated calls fill the logs and set off 5xx alerts.

### 2. NUL byte inside `name` / `buyerId` → 500 (spec gap)
- **Done:** `POST /sales {"name":"a\u0000b","stock":1}`. Then, on a fresh sale with stock 1, `POST /sales/:id/orders {"buyerId":"a\u0000b"}`.
- **Expected:** not specified. Both strings pass the spec's validation rules (`typeof === 'string' && trim() !== ''`), so by the letter of the spec they are valid and should return 201 and be stored "as received", which Postgres `TEXT` cannot do. Rejecting them with 400 is the other reasonable option. Either way, user input should not produce a 500. The human decides: 400 with a validation message, or strip or replace NUL before storing.
- **Happened:** 500 on both (`22021 invalid byte sequence for encoding "UTF8": 0x00`, from `prisma.sale.create` and `$executeRaw`). Integrity held: the failed reservation statement rolled back as a whole, so the sale's stock stayed 1 and no order row was written (the `stock` assertion in 2b passed before the status assertion failed).
- **Error output:**
```
AssertionError: expected [ 201, 400 ] to include 500
 ❯ test/sales.breaker.e2e-spec.ts:47:24   (2a)
 ❯ test/sales.breaker.e2e-spec.ts:55:24   (2b)
```
