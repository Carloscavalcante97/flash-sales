import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma.js';

// E2E against the real Postgres (docker compose, localhost:55432). Every test
// creates its own sale, so no cleanup is needed.
describe('Sales (e2e)', () => {
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

  async function createSale(stock: number, name = 'Tênis'): Promise<string> {
    const res = await http().post('/sales').send({ name, stock }).expect(201);
    return (res.body as { id: string }).id;
  }

  const order = (saleId: string, buyerId: string) =>
    http().post(`/sales/${saleId}/orders`).send({ buyerId });

  async function stockOf(saleId: string): Promise<number> {
    const res = await http().get(`/sales/${saleId}`).expect(200);
    return (res.body as { stock: number }).stock;
  }

  const ordersOf = (saleId: string) => prisma.order.findMany({ where: { saleId } });

  describe('POST /sales and GET /sales/:id', () => {
    it('criterion 1: POST /sales {"name":"Tênis","stock":10} -> 201 { id, name, stock } with no other keys', async () => {
      const res = await http().post('/sales').send({ name: 'Tênis', stock: 10 }).expect(201);

      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).not.toBe('');
      expect(res.body).toStrictEqual({ id: res.body.id, name: 'Tênis', stock: 10 });
    });

    it('criterion 2: GET /sales/:id with the created id -> 200 { id, name: "Tênis", stock: 10 }', async () => {
      const id = await createSale(10, 'Tênis');

      const res = await http().get(`/sales/${id}`).expect(200);

      expect(res.body).toStrictEqual({ id, name: 'Tênis', stock: 10 });
    });

    // Control step in the 404 tests: the same route serves a real sale first, so
    // the 404 is the unknown-sale 404 and not "route does not exist".
    it('criterion 3: GET /sales/does-not-exist -> 404 (not 500)', async () => {
      await http().get(`/sales/${await createSale(1)}`).expect(200);

      await http().get('/sales/does-not-exist').expect(404);
    });

    it('criterion 3: GET /sales/<random UUID> -> 404 (not 500)', async () => {
      await http().get(`/sales/${await createSale(1)}`).expect(200);

      await http().get(`/sales/${randomUUID()}`).expect(404);
    });

    it('edge case: arbitrary non-UUID :id ("abc") on GET -> 404, never 500', async () => {
      await http().get(`/sales/${await createSale(1)}`).expect(200);

      await http().get('/sales/abc').expect(404);
    });

    // criterion 4 + edge cases (boolean stock, null name, non-object JSON body)
    it.each([
      ['stock missing', { name: 'x' }],
      ['stock 0', { name: 'x', stock: 0 }],
      ['stock -1', { name: 'x', stock: -1 }],
      ['stock 1.5', { name: 'x', stock: 1.5 }],
      ['stock "5" (string)', { name: 'x', stock: '5' }],
      ['stock null', { name: 'x', stock: null }],
      ['stock 2147483648 (above int4 max)', { name: 'x', stock: 2147483648 }],
      ['stock true (boolean)', { name: 'x', stock: true }],
      ['name missing', { stock: 5 }],
      ['name ""', { name: '', stock: 5 }],
      ['name "   " (whitespace)', { name: '   ', stock: 5 }],
      ['name 123 (non-string)', { name: 123, stock: 5 }],
      ['name null', { name: null, stock: 5 }],
      ['non-object JSON body []', []],
    ])('criterion 4: POST /sales with %s -> 400 and no row in sales', async (_label, body) => {
      const before = await prisma.sale.count();

      await http().post('/sales').send(body).expect(400);

      expect(await prisma.sale.count()).toBe(before);
    });

    it('criterion 4: POST /sales with an empty request (no body) -> 400 and no row in sales', async () => {
      const before = await prisma.sale.count();

      await http().post('/sales').expect(400);

      expect(await prisma.sale.count()).toBe(before);
    });

    it('criterion 5: POST /sales {"name":"x","stock":2147483647} -> 201 with stock 2147483647', async () => {
      const res = await http().post('/sales').send({ name: 'x', stock: 2147483647 }).expect(201);

      expect(res.body).toStrictEqual({ id: res.body.id, name: 'x', stock: 2147483647 });
      expect(await stockOf(res.body.id)).toBe(2147483647);
    });

    it('criterion 6: extra fields { id: "forced", extra: 1 } -> 201, id is not "forced", no extra key echoed or stored', async () => {
      const res = await http()
        .post('/sales')
        .send({ name: 'x', stock: 3, id: 'forced', extra: 1 })
        .expect(201);

      expect(res.body.id).not.toBe('forced');
      expect(res.body).not.toHaveProperty('extra');
      expect(res.body).toStrictEqual({ id: res.body.id, name: 'x', stock: 3 });
      expect(await prisma.sale.findUnique({ where: { id: 'forced' } })).toBeNull();
      expect(await prisma.sale.findUnique({ where: { id: res.body.id } })).toStrictEqual({
        id: res.body.id,
        name: 'x',
        stock: 3,
      });
    });

    it('spec rule: name is stored as received, without trimming', async () => {
      const res = await http().post('/sales').send({ name: '  Tênis  ', stock: 1 }).expect(201);

      expect(res.body.name).toBe('  Tênis  ');
      const stored = await prisma.sale.findUnique({ where: { id: res.body.id } });
      expect(stored?.name).toBe('  Tênis  ');
    });
  });

  describe('POST /sales/:id/orders', () => {
    it('criterion 7: order on stock 2 -> 201 { orderId, status: "RESERVED" } and GET shows stock 1', async () => {
      const saleId = await createSale(2);

      const res = await order(saleId, 'b1').expect(201);

      expect(typeof res.body.orderId).toBe('string');
      expect(res.body.orderId).not.toBe('');
      expect(res.body).toStrictEqual({ orderId: res.body.orderId, status: 'RESERVED' });
      expect(await stockOf(saleId)).toBe(1);
    });

    it('criterion 8: the orders table has exactly one row { id: orderId, saleId, buyerId: "b1", status: "RESERVED" }', async () => {
      const saleId = await createSale(2);

      const res = await order(saleId, 'b1').expect(201);

      expect(await ordersOf(saleId)).toStrictEqual([
        { id: res.body.orderId, saleId, buyerId: 'b1', status: 'RESERVED' },
      ]);
    });

    it('criterion 9: stock 1 -> first order 201, second 409 { error: "SOLD_OUT" }, stock 0, exactly 1 order row', async () => {
      const saleId = await createSale(1);

      await order(saleId, 'b1').expect(201);
      const second = await order(saleId, 'b2').expect(409);

      expect(second.body).toStrictEqual({ error: 'SOLD_OUT' });
      expect(await stockOf(saleId)).toBe(0);
      expect(await ordersOf(saleId)).toHaveLength(1);
    });

    it('criterion 10: repeated orders on a sold-out sale keep returning 409, stock stays 0, no new order rows', async () => {
      const saleId = await createSale(1);
      await order(saleId, 'b1').expect(201);

      for (let i = 0; i < 5; i++) {
        const res = await order(saleId, `again-${i}`).expect(409);
        expect(res.body).toStrictEqual({ error: 'SOLD_OUT' });
      }

      expect(await stockOf(saleId)).toBe(0);
      expect(await ordersOf(saleId)).toHaveLength(1);
    });

    it('criterion 11: POST /sales/does-not-exist/orders {"buyerId":"b1"} -> 404 and no order row created', async () => {
      await order(await createSale(1), 'b1').expect(201); // control: the route reserves on a real sale
      const before = await prisma.order.count();

      await order('does-not-exist', 'b1').expect(404);

      expect(await prisma.order.count()).toBe(before);
    });

    it('edge case: non-UUID :id ("abc") and a random UUID on the order route -> 404, never 500, no order row', async () => {
      await order(await createSale(1), 'b1').expect(201); // control: the route reserves on a real sale
      const before = await prisma.order.count();

      await order('abc', 'b1').expect(404);
      await order(randomUUID(), 'b1').expect(404);

      expect(await prisma.order.count()).toBe(before);
    });

    // criterion 12 + edge case (non-object JSON body)
    it.each([
      ['{}', {}],
      ['buyerId ""', { buyerId: '' }],
      ['buyerId "   " (whitespace)', { buyerId: '   ' }],
      ['buyerId 123 (non-string)', { buyerId: 123 }],
      ['buyerId null', { buyerId: null }],
      ['non-object JSON body []', []],
    ])('criterion 12: order with %s -> 400, stock unchanged, no order row', async (_label, body) => {
      const saleId = await createSale(3);

      await http().post(`/sales/${saleId}/orders`).send(body).expect(400);

      expect(await stockOf(saleId)).toBe(3);
      expect(await ordersOf(saleId)).toHaveLength(0);
    });

    it('criterion 12: order with an empty request (no body) -> 400, stock unchanged, no order row', async () => {
      const saleId = await createSale(3);

      await http().post(`/sales/${saleId}/orders`).expect(400);

      expect(await stockOf(saleId)).toBe(3);
      expect(await ordersOf(saleId)).toHaveLength(0);
    });

    it('criterion 13: POST /sales/does-not-exist/orders with {} -> 400 (validation before lookup)', async () => {
      await http().post('/sales/does-not-exist/orders').send({}).expect(400);
    });

    it('criterion 17: the same buyerId reserves repeatedly while stock lasts (201, 201, then 409)', async () => {
      const saleId = await createSale(2);

      await order(saleId, 'same').expect(201);
      await order(saleId, 'same').expect(201);
      const third = await order(saleId, 'same').expect(409);

      expect(third.body).toStrictEqual({ error: 'SOLD_OUT' });
      const rows = await ordersOf(saleId);
      expect(rows.map((r) => r.buyerId)).toStrictEqual(['same', 'same']);
    });

    it('criterion 18: SQL-injection buyerId -> 201, stored verbatim, orders table still exists', async () => {
      const evil = "x'); DROP TABLE orders; --";
      const saleId = await createSale(1);

      const res = await order(saleId, evil).expect(201);

      const row = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(row?.buyerId).toBe(evil);
      const [{ t }] = await prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.orders')::text AS t`;
      expect(t).toBe('orders');
    });
  });

  describe('concurrency (real Postgres)', () => {
    it('criterion 14: 200 concurrent orders on stock 50 -> exactly 50 x 201 (distinct orderIds) + 150 x 409 SOLD_OUT, stock 0, 50 rows', async () => {
      const saleId = await createSale(50);

      const responses = await Promise.all(
        Array.from({ length: 200 }, (_, i) => order(saleId, `buyer-${i}`)),
      );

      const created = responses.filter((r) => r.status === 201);
      const soldOut = responses.filter((r) => r.status === 409);
      expect(created).toHaveLength(50);
      expect(soldOut).toHaveLength(150);
      expect(responses.filter((r) => r.status !== 201 && r.status !== 409).map((r) => r.status)).toStrictEqual([]);
      for (const r of soldOut) expect(r.body).toStrictEqual({ error: 'SOLD_OUT' });
      for (const r of created) expect(r.body.status).toBe('RESERVED');

      const orderIds = created.map((r) => r.body.orderId as string);
      expect(new Set(orderIds).size).toBe(50);
      expect(await stockOf(saleId)).toBe(0);
      const rows = await ordersOf(saleId);
      expect(rows).toHaveLength(50);
      expect(rows.map((r) => r.id).sort()).toStrictEqual([...orderIds].sort());
    }, 60_000);

    it('criterion 15: 100 concurrent orders on stock 1 -> exactly 1 x 201, 99 x 409, stock 0', async () => {
      const saleId = await createSale(1);

      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) => order(saleId, `buyer-${i}`)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      const soldOut = responses.filter((r) => r.status === 409);
      expect(soldOut).toHaveLength(99);
      for (const r of soldOut) expect(r.body).toStrictEqual({ error: 'SOLD_OUT' });
      expect(await stockOf(saleId)).toBe(0);
      expect(await ordersOf(saleId)).toHaveLength(1);
    }, 60_000);

    it('criterion 16: 30 interleaved concurrent orders on each of sale A (stock 5) and sale B (stock 5) -> 5 orders each, stock 0', async () => {
      const saleA = await createSale(5, 'A');
      const saleB = await createSale(5, 'B');

      const responses = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          order(i % 2 === 0 ? saleA : saleB, `buyer-${i}`).then((r) => ({ sale: i % 2 === 0 ? 'A' : 'B', r })),
        ),
      );

      for (const sale of ['A', 'B']) {
        const mine = responses.filter((x) => x.sale === sale).map((x) => x.r.status);
        expect(mine.filter((s) => s === 201)).toHaveLength(5);
        expect(mine.filter((s) => s === 409)).toHaveLength(25);
      }
      expect(await stockOf(saleA)).toBe(0);
      expect(await stockOf(saleB)).toBe(0);
      expect(await ordersOf(saleA)).toHaveLength(5);
      expect(await ordersOf(saleB)).toHaveLength(5);
    }, 60_000);
  });
});
