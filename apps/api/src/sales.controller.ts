import { BadRequestException, Body, Controller, Get, Headers, HttpException, Param, Post } from '@nestjs/common';
import { SalesService } from './sales.service.js';

// ponytail: inline validation, no validation lib installed; add a schema pipe when bodies grow.
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  create(@Body() body: Record<string, unknown> | undefined) {
    const name = body?.name;
    const stock = body?.stock;
    if (typeof name !== 'string' || name.trim() === '' || name.includes('\u0000')) {
      throw new BadRequestException('name must be a non-empty string without NUL characters');
    }
    if (typeof stock !== 'number' || !Number.isInteger(stock) || stock < 1 || stock > 2_147_483_647) {
      throw new BadRequestException('stock must be an integer between 1 and 2147483647');
    }
    return this.sales.create(name, stock);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sales.findOne(id);
  }

  @Post(':id/orders')
  async order(
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const buyerId = body?.buyerId;
    if (typeof buyerId !== 'string' || buyerId.trim() === '' || buyerId.includes('\u0000')) {
      throw new BadRequestException('buyerId must be a non-empty string without NUL characters');
    }
    if (key === undefined) return this.sales.reserve(id, buyerId);
    if (!/^[\x21-\x7E]{1,255}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 1 to 255 visible ASCII characters (0x21-0x7E)');
    }
    const saved = await this.sales.reserveOnce(id, buyerId, key);
    if (saved.status === 201) return saved.body;
    throw new HttpException(saved.body, saved.status); // stored 409 SOLD_OUT, replayed as-is
  }
}
