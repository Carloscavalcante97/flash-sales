import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma.js';

// F02: Idempotency-Key on POST /sales/:id/orders. Real Postgres (docker compose,
// localhost:55432). Every test creates its own sale(s) and its own random keys,
// and only asserts on rows filtered by its own sale ids.
describe('Sales Idempotency-Key (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function createSale(stock: number): Promise<string> {
    const res = await http().post('/sales').send({ name: 'F02', stock }).expect(201);
    return (res.body as { id: string }).id;
  }

  const order = (saleId: string, buyerId: string, key: string) =>
    http().post(`/sales/${saleId}/orders`).set('Idempotency-Key', key).send({ buyerId });

  async function stockOf(saleId: string): Promise<number> {
    const res = await http().get(`/sales/${saleId}`).expect(200);
    return (res.body as { stock: number }).stock;
  }

  const ordersOf = (saleId: string) => prisma.order.findMany({ where: { saleId } });
  const newKey = () => `k-${randomUUID()}`;

  describe('header validation', () => {
    it.each([
      ['empty value', ''],
      ['256 characters', 'a'.repeat(256)],
      ['a space (0x20) inside', 'abc def'],
      ['a tab inside', 'abc\tdef'],
      ['a non-ASCII character (é)', 'chavé'],
    ])('criterion 2: Idempotency-Key with %s -> 400, stock unchanged, no order row', async (_label, key) => {
      const saleId = await createSale(3);
      await order(await createSale(1), 'ctl', newKey()).expect(201); // control: the route accepts a valid key

      await order(saleId, 'b1', key).expect(400);

      expect(await stockOf(saleId)).toBe(3);
      expect(await ordersOf(saleId)).toHaveLength(0);
    });

    it('criterion 3: a 255-character key is valid -> 201, and the same key replays the same orderId', async () => {
      const saleId = await createSale(3);
      const key = newKey().padEnd(255, 'x');
      expect(key).toHaveLength(255);

      const first = await order(saleId, 'b1', key).expect(201);
      const again = await order(saleId, 'b1', key).expect(201);

      expect(again.body).toStrictEqual(first.body);
      expect(await ordersOf(saleId)).toHaveLength(1);
    });

    it('criterion 3: a key with every visible ASCII character (0x21..0x7E) is valid -> 201, replays the same orderId', async () => {
      const saleId = await createSale(3);
      const visible = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
      const key = visible + randomUUID();

      const first = await order(saleId, 'b1', key).expect(201);
      const again = await order(saleId, 'b1', key).expect(201);

      expect(again.body).toStrictEqual(first.body);
      expect(await ordersOf(saleId)).toHaveLength(1);
    });

    it('criterion 3: a 1-character key is valid -> 201, replays the same orderId', async () => {
      // A 1-char key cannot be made unique per run, so this test frees its own key first.
      await prisma.idempotencyKey.deleteMany({ where: { key: '~' } });
      const saleId = await createSale(3);

      const first = await order(saleId, 'b1', '~').expect(201);
      const again = await order(saleId, 'b1', '~').expect(201);

      expect(again.body).toStrictEqual(first.body);
      expect(await ordersOf(saleId)).toHaveLength(1);
    });
  });

  describe('first request and replay', () => {
    it('criterion 4: first request with a key is processed as in F01 -> 201 { orderId, status: "RESERVED" }, stock -1, one order row, and the 201 is stored', async () => {
      const saleId = await createSale(2);
      const key = newKey();

      const res = await order(saleId, 'b1', key).expect(201);

      expect(res.body).toStrictEqual({ orderId: res.body.orderId, status: 'RESERVED' });
      expect(await stockOf(saleId)).toBe(1);
      expect(await ordersOf(saleId)).toStrictEqual([
        { id: res.body.orderId, saleId, buyerId: 'b1', status: 'RESERVED' },
      ]);
      const replay = await order(saleId, 'b1', key).expect(201);
      expect(replay.body).toStrictEqual({ orderId: res.body.orderId, status: 'RESERVED' });
    });

    it('criterion 5: same key, same sale, same buyerId after 201 -> exactly the same status and body, no new order, stock unchanged', async () => {
      const saleId = await createSale(5);
      const key = newKey();
      const first = await order(saleId, 'b1', key).expect(201);

      for (let i = 0; i < 3; i++) {
        const again = await order(saleId, 'b1', key);
        expect(again.status).toBe(201);
        expect(again.text).toBe(first.text);
      }

      expect(await stockOf(saleId)).toBe(4);
      expect((await ordersOf(saleId)).map((o) => o.id)).toStrictEqual([first.body.orderId]);
    });

    it('criterion 6: a 409 SOLD_OUT is stored -> replay returns 409 { error: "SOLD_OUT" } even after stock is refilled, no order, stock untouched', async () => {
      const saleId = await createSale(1);
      await http().post(`/sales/${saleId}/orders`).send({ buyerId: 'other' }).expect(201);
      const key = newKey();

      const first = await order(saleId, 'b2', key).expect(409);
      expect(first.body).toStrictEqual({ error: 'SOLD_OUT' });

      await prisma.sale.update({ where: { id: saleId }, data: { stock: 5 } });
      const again = await order(saleId, 'b2', key);

      expect(again.status).toBe(409);
      expect(again.text).toBe(first.text);
      expect(await stockOf(saleId)).toBe(5);
      expect((await ordersOf(saleId)).map((o) => o.buyerId)).toStrictEqual(['other']);
    });
  });

  describe('key reused with other parameters', () => {
    it('criterion 7: same key with another sale -> 422 { error: "IDEMPOTENCY_KEY_REUSED" }, no order in the other sale, its stock unchanged', async () => {
      const saleA = await createSale(3);
      const saleB = await createSale(3);
      const key = newKey();
      await order(saleA, 'b1', key).expect(201);

      const res = await order(saleB, 'b1', key).expect(422);

      expect(res.body).toStrictEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await ordersOf(saleB)).toHaveLength(0);
      expect(await stockOf(saleB)).toBe(3);
      expect(await ordersOf(saleA)).toHaveLength(1);
      expect(await stockOf(saleA)).toBe(2);
    });

    it('criterion 8: same key with another buyerId -> 422 { error: "IDEMPOTENCY_KEY_REUSED" }, no new order, stock unchanged', async () => {
      const saleId = await createSale(3);
      const key = newKey();
      await order(saleId, 'b1', key).expect(201);

      const res = await order(saleId, 'b2', key).expect(422);

      expect(res.body).toStrictEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
      expect((await ordersOf(saleId)).map((o) => o.buyerId)).toStrictEqual(['b1']);
      expect(await stockOf(saleId)).toBe(2);
    });

    it('criterion 8 (fix 1): key first used by buyerId "b\\ud800" (lone surrogate), then by the different buyerId "b\\ufffd" -> 422, no new order', async () => {
      const saleId = await createSale(3);
      const key = newKey();
      await order(saleId, 'b\ud800', key).expect(201);

      const res = await order(saleId, 'b\ufffd', key).expect(422);

      expect(res.body).toStrictEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await ordersOf(saleId)).toHaveLength(1);
      expect(await stockOf(saleId)).toBe(2);
    });

    it('criterion 8: a key stored with 409 SOLD_OUT reused with another buyerId -> 422, no order', async () => {
      const saleId = await createSale(1);
      await http().post(`/sales/${saleId}/orders`).send({ buyerId: 'other' }).expect(201);
      const key = newKey();
      await order(saleId, 'b1', key).expect(409);
      await prisma.sale.update({ where: { id: saleId }, data: { stock: 5 } });

      const res = await order(saleId, 'b2', key).expect(422);

      expect(res.body).toStrictEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
      expect((await ordersOf(saleId)).map((o) => o.buyerId)).toStrictEqual(['other']);
      expect(await stockOf(saleId)).toBe(5);
    });
  });

  describe('400 and 404 are not stored', () => {
    it('criterion 9: key on a missing sale -> 404, then the same key on a real sale -> 201 (not 422) and is bound to it', async () => {
      const saleId = await createSale(3);
      const key = newKey();

      await order(randomUUID(), 'b1', key).expect(404);
      const first = await order(saleId, 'b1', key).expect(201);
      const again = await order(saleId, 'b1', key).expect(201);

      expect(again.body).toStrictEqual(first.body);
      expect(await ordersOf(saleId)).toHaveLength(1);
      expect(await stockOf(saleId)).toBe(2);
    });

    it('criterion 10: key with an invalid body -> 400, then the same key with another buyerId -> 201 (not 422) and is bound to it', async () => {
      const saleId = await createSale(3);
      const key = newKey();

      await http().post(`/sales/${saleId}/orders`).set('Idempotency-Key', key).send({ buyerId: '' }).expect(400);
      const first = await order(saleId, 'b2', key).expect(201);
      const again = await order(saleId, 'b2', key).expect(201);

      expect(again.body).toStrictEqual(first.body);
      expect((await ordersOf(saleId)).map((o) => o.buyerId)).toStrictEqual(['b2']);
      expect(await stockOf(saleId)).toBe(2);
    });
  });

  describe('concurrency (real Postgres)', () => {
    it('criterion 11: 30 concurrent requests with the same key -> at most one order, each 201 with the same orderId or 409 IDEMPOTENCY_IN_PROGRESS, stock -1', async () => {
      const saleId = await createSale(10);
      const key = newKey();

      const responses = await Promise.all(Array.from({ length: 30 }, () => order(saleId, 'b1', key)));

      const created = responses.filter((r) => r.status === 201);
      const inProgress = responses.filter((r) => r.status === 409);
      expect(created.length + inProgress.length).toBe(30);
      expect(created.length).toBeGreaterThanOrEqual(1);
      for (const r of inProgress) expect(r.body).toStrictEqual({ error: 'IDEMPOTENCY_IN_PROGRESS' });
      const orderIds = new Set(created.map((r) => r.body.orderId as string));
      expect(orderIds.size).toBe(1);
      for (const r of created) expect(r.body).toStrictEqual({ orderId: [...orderIds][0], status: 'RESERVED' });

      expect((await ordersOf(saleId)).map((o) => o.id)).toStrictEqual([...orderIds]);
      expect(await stockOf(saleId)).toBe(9);
    }, 60_000);

    it('criterion 12: 10 keys x 5 concurrent requests each on stock 3 -> one order per winning key, stock 0, never two orders for a key', async () => {
      const saleId = await createSale(3);
      const keys = Array.from({ length: 10 }, newKey);

      const responses = await Promise.all(
        keys.flatMap((key, k) =>
          Array.from({ length: 5 }, () => order(saleId, `buyer-${k}`, key).then((r) => ({ key, r }))),
        ),
      );

      const allowed = [{ error: 'SOLD_OUT' }, { error: 'IDEMPOTENCY_IN_PROGRESS' }];
      for (const { r } of responses) {
        if (r.status === 201) expect(r.body.status).toBe('RESERVED');
        else {
          expect(r.status).toBe(409);
          expect(allowed).toContainEqual(r.body);
        }
      }
      const rows = await ordersOf(saleId);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((o) => o.buyerId)).size).toBe(3);
      for (const key of keys) {
        const ids = new Set(responses.filter((x) => x.key === key && x.r.status === 201).map((x) => x.r.body.orderId));
        expect(ids.size).toBeLessThanOrEqual(1);
      }
      expect(await stockOf(saleId)).toBe(0);
    }, 60_000);
  });
});
