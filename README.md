# Flash Sales

**English** · [Deutsch](README.de.md) · [Português](README.pt-BR.md)

A backend for flash sales: limited stock, hundreds of buyers pressing "buy" in
the same second, and one rule that can't break: never sell more than you have.

The repository is also a measured experiment. Every feature is built twice,
once by a multi-agent AI delivery pipeline and once by Claude Code used
directly, and the two are compared on rework, defects and cost.

## Why this project

Flash sales are a small domain with hard problems: race conditions on stock,
retried requests that must not create duplicate orders, reservations that
expire, and events that must survive a worker crash. Each feature on the
roadmap takes on one of these problems and comes with an invariant that a
black-box test can check.

The second goal is to answer a question with data instead of opinion: does an
AI pipeline with planner, coder, tester and reviewer agents really cut rework
compared with a single agent, and what does it cost? The protocol, the
hypotheses and the decision rule were written down before the first feature.
Negative results get published too.

## Status

| ID | Feature | Invariant checked by the oracle | Status |
|---|---|---|---|
| F01 | Sale with stock + atomic reservation | N concurrent orders on stock E give exactly E successes | done |
| F02 | `Idempotency-Key` on orders | the same key sent twice, even at the same time, gives 1 order and the same response | in progress |
| F03 | Reservation expiry | an unpaid reservation expires after the TTL and the stock comes back | planned |
| F04 | Transactional outbox + RabbitMQ | no order is left without an event, even if the worker dies midway | planned |
| F05 | Saga with compensation | a declined payment cancels the order and returns the stock | planned |
| F06 | Waiting room | never more than N active tokens; a queue position only goes down | planned |
| F07 | Retry + DLQ | transient failures recover with retry; permanent ones land in the DLQ; reprocessing works | planned |

## Stack

- TypeScript 6 on Node.js 24, NestJS 12 (ESM)
- PostgreSQL 17 through Prisma 7 (driver adapter `@prisma/adapter-pg`)
- Redis 7 (provisioned in Docker Compose, not used yet)
- Vitest 4 + Supertest for e2e tests against a real database
- oxlint (type-aware) and Prettier
- pnpm 11 workspaces + Turborepo
- Docker Compose for local infrastructure

## How the atomic reservation works (F01)

The classic bug is read, check, write: read the stock, check that it's above
zero, then write `stock - 1`. Two requests read `stock = 1` at the same moment,
both pass the check, and one unit gets sold twice.

Here the reservation is a single SQL statement
([`sales.service.ts`](apps/api/src/sales.service.ts)):

```sql
WITH reserved AS (
  UPDATE sales SET stock = stock - 1
  WHERE id = $saleId AND stock > 0
  RETURNING id
)
INSERT INTO orders (id, "saleId", "buyerId")
SELECT $orderId, id, $buyerId FROM reserved;
```

- The `UPDATE` takes a row lock. Concurrent requests for the same sale wait on
  it, and when each one gets the lock, Postgres re-checks `stock > 0` against
  the latest version of the row. Stock never goes below zero.
- The decrement and the insert live in the same statement, so they commit or
  fail together, with no interactive transaction and one round trip to the
  database.
- When no row is inserted, the service tells "sale doesn't exist" (`404`)
  apart from "sold out" (`409 SOLD_OUT`).

Why not the usual alternatives:

- `SELECT ... FOR UPDATE` inside an interactive transaction is correct too, but
  it holds the lock across several round trips.
- A counter in Redis is fast, but then the stock lives in two stores that can
  disagree.

### Tests

The e2e suite runs against the real Postgres from Docker Compose, with no
mocks. Among the cases:

- 200 concurrent orders on stock 50: exactly 50 × `201` with distinct order
  ids, 150 × `409`, final stock 0 and 50 rows in `orders`
- 100 concurrent orders on stock 1: exactly one success
- interleaved concurrent orders on two sales: no stock leaks from one to the
  other
- hostile input: NUL bytes in the path and body (they used to cause a `500`,
  because Postgres rejects `0x00` in text) and SQL injection in `buyerId`,
  which is stored verbatim

## API

| Method | Route | Body | Responses |
|---|---|---|---|
| `POST` | `/sales` | `{ "name": string, "stock": integer ≥ 1 }` | `201 { id, name, stock }` · `400` |
| `GET` | `/sales/:id` | none | `200 { id, name, stock }` · `404` |
| `POST` | `/sales/:id/orders` | `{ "buyerId": string }` | `201 { orderId, status: "RESERVED" }` · `409 { error: "SOLD_OUT" }` · `404` · `400` |

## Running locally

You need Node.js 24, pnpm 11 and Docker.

```bash
docker compose up -d                          # Postgres on :55432, Redis on :56379
pnpm install                                  # also generates the Prisma client
pnpm --filter api exec prisma migrate deploy  # creates the tables
pnpm --filter api start:dev                   # API on http://localhost:3000
```

No `.env` is needed: the app falls back to the Docker Compose database. Set
`DATABASE_URL` to use another one.

```bash
curl -s -X POST localhost:3000/sales \
  -H 'content-type: application/json' -d '{"name":"Sneakers","stock":2}'
curl -s -X POST localhost:3000/sales/<id>/orders \
  -H 'content-type: application/json' -d '{"buyerId":"alice"}'
```

Checks:

```bash
pnpm typecheck
pnpm lint
pnpm --filter api test:e2e   # needs docker compose up
```

## The experiment: AI pipeline vs. Claude Code direct

**Question.** How much post-delivery rework does a multi-agent pipeline
(Planner → Coder → Simplifier → Tester → Breaker → E2E → Reviewer) prevent
compared with Claude Code used directly, and how much more does it cost?

**Hypotheses, registered up front.** H1: rework drops by at least 30% with the
pipeline. H2: the pipeline passes more oracle tests on the first delivery. H3:
the pipeline spends 3 to 5 times more tokens and wall-clock time, but needs
fewer minutes of human attention.

**Design.**

- Paired A/B per feature: both arms start from the same commit (tag
  `F0X-base`), with the same model and the same frozen feature description.
- Hidden oracle: black-box HTTP acceptance tests, written before either arm
  runs and kept outside the repo so that no agent sees them.
- Blind review: `scripts/rework.sh blind F0X` shuffles the two diffs into A and
  B, and defects are logged before the key is opened.
- Rework is lines added plus removed between the `done` and `accepted` tags,
  computed by `pnpm rework`, never by hand.
- Decision rule, set before F02: the pipeline counts as a real gain only if,
  from F02 to F07, it ships with fewer defects than the direct arm in at least
  half of the features while spending at most 2.5 times the tokens.

### F01 results

| | direct | pipeline |
|---|---:|---:|
| oracle on first delivery | 14/14 | 14/14 |
| blind-review defects (high/medium/low) | 1/0/0 | 0/0/3 |
| rework until accepted (± lines) | 18 | 0 |
| fix rounds | 1 | 0 |
| lines shipped: production / tests | 132 / 125 | 127 / 486 |
| tokens until accepted | 154,690 | 951,306 |
| wall-clock time until accepted | 3.8 min | 36.1 min |

What this says so far:

- The pipeline's adversarial stage (the Breaker) found the only real bug: a NUL
  byte in the input turned into a `500`. The direct arm shipped that bug, and
  the oracle missed it as well.
- H1 holds on paper (18 lines against 0), H2 doesn't (a tie at 14/14), and H3
  underestimated the cost: 6.2 times the tokens and 9.4 times the wall-clock
  time. Half of that went into fix loops, and one of them only repaired a flaky
  suite the pipeline itself had created.
- n = 1. Nothing generalizes yet.

Those numbers led to **pipeline v2**: one Builder doing TDD in a single context
and one independent Verifier that attacks the running API, with the Planner and
the other stages joining only when a trigger fires. New hypothesis H4: v2
spends at most 40% of v1's tokens with the same quality.

### Threats to validity

- **Small sample (n = 7 features).** This is a case study: results are shown
  feature by feature, with no p-values.
- **The same person writes the oracle and reviews.** Mitigated by writing the
  oracle first and reviewing blind. In F01 the oracle was written by Claude and
  had no hostile-input cases; from F02 on, it does.
- **Blinding is imperfect.** The pipeline's diff usually carries more tests and
  can be recognized.
- **Learning between features.** Pairing on the same feature neutralizes it,
  and the order of the arms alternates.
- **Cost is underestimated in F01.** Human minutes weren't measured and the
  pipeline orchestrator's tokens weren't counted.

Full documentation, in Portuguese: [protocol](docs/experiment/PROTOCOL.md),
[results](docs/experiment/RESULTS.md), [pipeline v2](docs/experiment/PIPELINE-V2.md)
and [raw data](docs/experiment/ledger.csv).

## Repository layout

```
apps/api/              NestJS API
  src/sales.*.ts       F01 controller and service
  prisma/              schema and migrations
  test/                e2e tests against the real Postgres
docs/experiment/       protocol, feature specs, results, ledger and run evidence
scripts/rework.sh      rework metrics and blind-review export
docker-compose.yml     Postgres 17 + Redis 7 for local development
```

## Conventions

- **Git flow.** `main` holds releases, `develop` integrates, and each feature
  lives on a `feature/*` branch merged with `--no-ff`.
- **Conventional Commits.** The commit body explains why, not only what.
- **`ponytail:` comments** mark deliberate simplifications and say when to
  upgrade them, for example inline validation until request bodies grow.
