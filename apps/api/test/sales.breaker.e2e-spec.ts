import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma.js';

// Breaker: attacks against F01. Real Postgres (docker compose, localhost:55432).
describe('Sales (breaker)', () => {
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
    const res = await http().post('/sales').send({ name: 'Breaker', stock }).expect(201);
    return (res.body as { id: string }).id;
  }

  // Spec: "Any string in `:id` must yield a clean 404" / "Arbitrary non-UUID strings as `:id` -> 404, never 500".
  it('attack 1a: GET /sales/%00 (NUL byte as :id) -> 404', async () => {
    const res = await http().get('/sales/%00');
    expect(res.status).toBe(404);
  });

  it('attack 1b: POST /sales/%00/orders {"buyerId":"b1"} -> 404', async () => {
    const res = await http().post('/sales/%00/orders').send({ buyerId: 'b1' });
    expect(res.status).toBe(404);
  });

  // Not specified: strings that pass the spec's validation rule but Postgres TEXT cannot store.
  it('attack 2a: POST /sales with a NUL byte inside name -> 201 or 400, never 500', async () => {
    const res = await http().post('/sales').send({ name: 'a\u0000b', stock: 1 });
    expect([201, 400]).toContain(res.status);
  });

  it('attack 2b: POST /sales/:id/orders with a NUL byte inside buyerId -> 201 or 400, never 500; no unit lost', async () => {
    const saleId = await createSale(1);
    const res = await http().post(`/sales/${saleId}/orders`).send({ buyerId: 'a\u0000b' });
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    expect(sale?.stock).toBe(res.status === 201 ? 0 : 1);
    expect([201, 400]).toContain(res.status);
  });
});
