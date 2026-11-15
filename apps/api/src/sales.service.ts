import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async reserve(saleId: string, buyerId: string) {
    if (saleId.includes('\u0000')) throw new NotFoundException();
    const orderId = randomUUID();
    // ponytail: one statement = decrement + insert are atomic with no interactive transaction.
    // Under concurrency Postgres waits on the row lock and re-checks `stock > 0`
    // on the new row version, so stock can never go below 0.
    const inserted = await this.prisma.$executeRaw`
      WITH reserved AS (
        UPDATE sales SET stock = stock - 1
        WHERE id = ${saleId} AND stock > 0
        RETURNING id
      )
      INSERT INTO orders (id, "saleId", "buyerId")
      SELECT ${orderId}, id, ${buyerId} FROM reserved`;
    if (inserted === 1) return { orderId, status: 'RESERVED' as const };
    await this.findOne(saleId); // throws 404 if the sale does not exist
    throw new ConflictException({ error: 'SOLD_OUT' });
  }
}
