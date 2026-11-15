import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        // ponytail: defaults to the docker-compose DB, so dev/test need no .env
        connectionString: process.env.DATABASE_URL ?? 'postgresql://flash:flash@localhost:55432/flash',
      }),
    });
  }

  onModuleDestroy() {
    return this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
