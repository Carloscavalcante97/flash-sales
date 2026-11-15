import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma.js';

// Fix Plan (iteration 1), criteria F1-F4: a NUL (U+0000) in :id, name or buyerId.
// Postgres `text` cannot hold NUL, so these strings must never reach the DB.
// Real Postgres (docker compose, localhost:55432). Every test creates its own sale.
describe('Sales NUL handling (e2e)', () => {
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
    const res = await http().post('/sales').send({ name: 'NUL fix', stock }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function stockOf(saleId: string): Promise<number> {
    const res = await http().get(`/sales/${saleId}`).expect(200);
    return (res.body as { stock: number }).stock;
  }

  it('F1: GET /sales/%00 -> 404 (not 500)', async () => {
    // Control: the same route serves a real sale, so the 404 below comes from the lookup.
    const id = await createSale(1);
    await http().get(`/sales/${id}`).expect(200);

    const res = await http().get('/sales/%00');

    expect(res.status).toBe(404);
  });

  it('F1 (edge): GET /sales/<real id>%00 -> 404, a NUL-suffixed id never matches the real sale', async () => {
    const id = await createSale(1);

    const res = await http().get(`/sales/${id}%00`);

    expect(res.status).toBe(404);
  });

  it('F1: POST /sales/%00/orders {"buyerId":"b1"} -> 404 and no order row created', async () => {
    // Control: the order route reserves on a real sale, so the 404 below comes from the lookup.
    const id = await createSale(1);
    await http().post(`/sales/${id}/orders`).send({ buyerId: 'b1' }).expect(201);
    const buyerId = `b1-${randomUUID()}`;

    const res = await http().post('/sales/%00/orders').send({ buyerId });

    expect(res.status).toBe(404);
    expect(await prisma.order.count({ where: { buyerId } })).toBe(0);
  });

  it('F2: POST /sales/%00/orders with {} -> 400 (validation before the lookup)', async () => {
    const res = await http().post('/sales/%00/orders').send({});

    expect(res.status).toBe(400);
  });

  it('F3: POST /sales with a NUL inside name -> 400 and no new row in sales', async () => {
    const marker = `nul-${randomUUID()}`;

    const res = await http()
      .post('/sales')
      .send({ name: `${marker}:a\u0000b`, stock: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('name must be a non-empty string without NUL characters');
    expect(await prisma.sale.count({ where: { name: { startsWith: marker } } })).toBe(0);
  });

  it('F4: POST /sales/:id/orders {"buyerId":"a\\u0000b"} on stock 1 -> 400, stock stays 1, no order row', async () => {
    const id = await createSale(1);

    const res = await http().post(`/sales/${id}/orders`).send({ buyerId: 'a\u0000b' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('buyerId must be a non-empty string without NUL characters');
    expect(await stockOf(id)).toBe(1);
    expect(await prisma.order.count({ where: { saleId: id } })).toBe(0);
  });
});
