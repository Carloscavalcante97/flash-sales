# F01: venda com estoque e compra com reserva atômica

## Contrato da API

- `POST /sales` `{ "name": string, "stock": inteiro > 0 }`
  → `201 { "id", "name", "stock" }` · `400` se o payload for inválido
- `GET /sales/:id` → `200 { "id", "name", "stock" }` (stock = unidades disponíveis) · `404`
- `POST /sales/:id/orders` `{ "buyerId": string }`
  → `201 { "orderId", "status": "RESERVED" }` · `409 { "error": "SOLD_OUT" }` · `404` se a venda não existir · `400` sem `buyerId`

## Regras

- Nunca vender além do estoque, mesmo com centenas de requisições simultâneas.
- Cada pedido reserva 1 unidade.
- Postgres via Prisma (o `PrismaService` já existe em `apps/api/src/prisma.ts`). Sem Redis nesta feature.

## Fora do escopo

Pagamento, expiração da reserva, idempotência e autenticação.
