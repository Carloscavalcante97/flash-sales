import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [AppController, SalesController],
  providers: [AppService, SalesService],
})
export class AppModule {}
