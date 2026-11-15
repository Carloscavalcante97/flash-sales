import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.js';

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  create(name: string, stock: number) {
    return this.prisma.sale.create({ data: { name, stock } });
  }

  async findOne(id: string) {
    if (id.includes('\u0000')) throw new NotFoundException(); // ponytail: Postgres text can't hold NUL (22021) and generated ids never contain it, so no such sale exists
    const sale = await this.prisma.sale.findUnique({ where: { id } });
    if (!sale) throw new NotFoundException();
    return sale;
  }

  async reserve(saleId: string, buyerId: string, db: Prisma.TransactionClient = this.prisma) {
    if (saleId.includes('\u0000')) throw new NotFoundException();
    const orderId = randomUUID();
    // ponytail: one statement = decrement + insert are atomic with no interactive transaction.
    // Under concurrency Postgres waits on the row lock and re-checks `stock > 0`
    // on the new row version, so stock can never go below 0.
    const inserted = await db.$executeRaw`
      WITH reserved AS (
        UPDATE sales SET stock = stock - 1
        WHERE id = ${saleId} AND stock > 0
        RETURNING id
      )
      INSERT INTO orders (id, "saleId", "buyerId")
      SELECT ${orderId}, id, ${buyerId} FROM reserved`;
    if (inserted === 1) return { orderId, status: 'RESERVED' as const };
    if (!(await db.sale.findUnique({ where: { id: saleId } }))) throw new NotFoundException();
    throw new ConflictException({ error: 'SOLD_OUT' });
  }

  // Claim the key, reserve and store the response in ONE transaction: a 404 (or a crash)
  // rolls the claim back, so the key stays free, and a committed key always has its response.
  // A concurrent request with the same key blocks on the key's primary key until the first
  // commits, then replays it, so it never sees an in-progress key (no IDEMPOTENCY_IN_PROGRESS).
  // ponytail: each blocked same-key request holds a pool connection while it waits; switch to
  // claim-then-409-IN_PROGRESS if same-key bursts ever exhaust the pool.
  reserveOnce(saleId: string, buyerId: string, key: string) {
    // pg writes a lone UTF-16 surrogate as U+FFFD, so "b\ud800" and "b\ufffd" would read back
    // equal. JSON.stringify escapes lone surrogates, so the stored form is lossless.
    const buyer = JSON.stringify(buyerId);
    // maxWait/timeout: wait on a locked sale like F01 does, instead of Prisma's 2 s / 5 s defaults
    // turning it into a 500. ponytail: 2^31-1 ms (~24.8 days) is the largest delay setTimeout
    // accepts (Infinity overflows to 1 ms) and Prisma rejects 0, so this is "no timeout".
    return this.prisma.$transaction(async (tx) => {
      // A NUL can't be stored in text (22021) and no sale id holds one: don't claim, only check the key.
      const claimed =
        !saleId.includes('\u0000') &&
        (await tx.$executeRaw`
          INSERT INTO idempotency_keys ("key", "saleId", "buyerId") VALUES (${key}, ${saleId}, ${buyer})
          ON CONFLICT ("key") DO NOTHING`) === 1;
      if (!claimed) {
        const saved = await tx.idempotencyKey.findUnique({ where: { key } });
        if (!saved) throw new NotFoundException();
        if (saved.saleId !== saleId || saved.buyerId !== buyer) {
          throw new UnprocessableEntityException({ error: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return { status: saved.status!, body: saved.body as Prisma.JsonObject }; // committed rows always carry both
      }
      let response: { status: number; body: Prisma.InputJsonObject };
      try {
        response = { status: 201, body: await this.reserve(saleId, buyerId, tx) };
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e; // 404 / errors: roll back, key stays free
        response = { status: 409, body: e.getResponse() as Prisma.InputJsonObject };
      }
      await tx.idempotencyKey.update({ where: { key }, data: response });
      return response;
    }, { maxWait: 2 ** 31 - 1, timeout: 2 ** 31 - 1 });
  }
}
