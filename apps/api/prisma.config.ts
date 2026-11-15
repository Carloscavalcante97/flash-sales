import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // ponytail: defaults to the docker-compose DB, so dev/test need no .env
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://flash:flash@localhost:55432/flash' },
});
