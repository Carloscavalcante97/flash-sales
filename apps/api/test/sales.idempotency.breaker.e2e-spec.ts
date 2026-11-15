import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma.js';

// Verifier attacks on F02 (Idempotency-Key) over real HTTP. Real Postgres (localhost:55432).
// BREAKER_URL=http://localhost:3998 targets an already running API; otherwise the app listens on a free port here.
let BASE = process.env.BREAKER_URL ?? '';

describe('F02 Idempotency-Key (breaker)', () => {
  const prisma = new PrismaService();
  let app: INestApplication | undefined;

  beforeAll(async () => {
    if (BASE) return;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.listen(0);
    BASE = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  async function createSale(stock: number): Promise<string> {
    const res = await fetch(`${BASE}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'F02 breaker', stock }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function order(saleId: string, buyerId: string, key: string) {
    const res = await fetch(`${BASE}/sales/${saleId}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ buyerId }),
    });
    return { status: res.status, text: await res.text() };
  }

  // Attack 1 (held, removed): 2000 concurrent keyed requests (1000 keys x 2) on stock 200 -> no 5xx, 200 orders.

  const ordersOf = (saleId: string) => prisma.order.findMany({ where: { saleId } });
  const stockOf = async (saleId: string) => (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).stock;

  // Attack 2: property-style. A byte-identical retry (same key, same sale, same buyerId) must replay
  // the stored 201, whatever the buyerId string is (unicode, emoji, combining marks, RTL, lone surrogates, long).
  it('attack 2: identical retry replays 201 for 60 generated unicode buyerIds (never 422)', async () => {
    const pool = ['a', 'Z', ' ', 'é', 'é', 'ß', '中', '‮', '😀', '\uD83D', '\uDE00', '￿', ' ', '"', '\\', "'", '\t', '\n'];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const buyerIds = Array.from({ length: 60 }, (_, i) => {
      const len = 1 + rnd(i === 0 ? 1 : 40);
      return 'b' + Array.from({ length: len }, () => pool[rnd(pool.length)]).join('');
    });
    buyerIds.push('b' + 'x'.repeat(50_000)); // long but under the 100kb body limit

    const failures: { buyerId: string; first: number; replay: number; body: string }[] = [];
    for (const buyerId of buyerIds) {
      const saleId = await createSale(5);
      const key = `uni-${randomUUID()}`;
      const first = await order(saleId, buyerId, key);
      const replay = await order(saleId, buyerId, key);
      if (first.status !== 201 || replay.status !== 201 || replay.text !== first.text) {
        failures.push({ buyerId: JSON.stringify(buyerId).slice(0, 60), first: first.status, replay: replay.status, body: replay.text });
      }
      expect(await ordersOf(saleId)).toHaveLength(first.status === 201 ? 1 : 0);
    }
    expect(failures).toStrictEqual([]);
  }, 120_000);

  // Attack 3: slow dependency. The sale row is locked by another DB session for 7 s (e.g. a long admin
  // transaction). A keyed request must behave as F01 (wait, then 201), and the key must decrement stock at most once.
  it('attack 3: sale row locked 7 s -> keyed request still 201 like F01; retry replays; stock -1 exactly once', async () => {
    const saleId = await createSale(5);
    const key = `slow-${randomUUID()}`;
    let pending!: Promise<{ status: number; text: string }>;
    let unkeyed!: Promise<Response>;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;
        pending = order(saleId, 'slow-buyer', key);
        unkeyed = fetch(`${BASE}/sales/${saleId}/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ buyerId: 'f01-buyer' }),
        });
        await new Promise((r) => setTimeout(r, 7000));
      },
      { timeout: 30_000 },
    );
    const first = await pending;
    const f01 = await unkeyed;
    await new Promise((r) => setTimeout(r, 500)); // let any timed-out tx finish rolling back
    const retry = await order(saleId, 'slow-buyer', key);

    const keyed = (await ordersOf(saleId)).filter((o) => o.buyerId === 'slow-buyer');
    expect({ keyedOrders: keyed.length, stock: await stockOf(saleId) }).toStrictEqual({ keyedOrders: 1, stock: 3 });
    expect({ f01: f01.status, first: first.status, firstBody: first.text.slice(0, 200), retry: retry.status }).toStrictEqual({
      f01: 201,
      first: 201,
      firstBody: first.text.slice(0, 200),
      retry: 201,
    });
  }, 60_000);
});
