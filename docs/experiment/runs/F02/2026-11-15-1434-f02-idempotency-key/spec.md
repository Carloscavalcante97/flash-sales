# Spec: F02 Idempotency-Key na compra (request verbatim — Planner skipped: DoR met)

# F02: Idempotency-Key na compra

## Contrato da API

`POST /sales/:id/orders` passa a aceitar o header opcional `Idempotency-Key`.

- Sem o header, o comportamento da F01 não muda.
- O valor válido tem de 1 a 255 caracteres ASCII visíveis (0x21 a 0x7E). Fora
  disso → `400`.
- Na primeira requisição com uma chave, o pedido é processado como na F01. Se a
  resposta for `201` ou `409 { "error": "SOLD_OUT" }`, status e corpo são
  guardados.
- A mesma chave com a mesma venda e o mesmo `buyerId` devolve exatamente o
  status e o corpo guardados, sem criar pedido e sem mexer no estoque.
- A mesma chave com outra venda ou outro `buyerId` → `422 { "error": "IDEMPOTENCY_KEY_REUSED" }`,
  sem criar pedido.
- Requisições simultâneas com a mesma chave criam no máximo um pedido. Cada uma
  responde `201` com o mesmo `orderId` ou `409 { "error": "IDEMPOTENCY_IN_PROGRESS" }`.
- Respostas `400` e `404` não são guardadas: a chave continua livre.

## Regras

- Nunca existem dois pedidos para a mesma chave, nem sob concorrência.
- O estoque é decrementado no máximo uma vez por chave.
- Postgres via Prisma, sem Redis. Implementar à mão, sem `@nestjs/idempotency`.

## Fora do escopo

Expiração das chaves, autenticação e pagamento.

## Decisions
- Requisição com chave sob trava longa da venda (ataque 3 do Verifier) → espera como a F01, sem 500 por timeout da transação (decisão humana, fix 1).
