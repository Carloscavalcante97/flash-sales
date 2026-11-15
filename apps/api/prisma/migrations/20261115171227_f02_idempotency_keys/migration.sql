-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" INTEGER,
    "body" JSON,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);
