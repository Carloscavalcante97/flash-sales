# Commits

## Status
committed

## Identity
Antônio Carlos Bezerra Cavalcante Junior <antonio.developer@icloud.com> — conta compartilhada: não
(Trocar o nome salvo: `git config --global --unset pipeline.commitAuthor`)

## Branch
feature/f02-pipeline → base do PR: develop (existe localmente; `origin/develop` está uma versão atrás, sem 79bd628 nem dc946a0/ac38252)

## Commits
- `a38d792` feat(db): adicionar tabela de chaves de idempotência
- `7ee70bb` feat(sales): aceitar header Idempotency-Key na compra
- `42cf25e` test(sales): cobrir critérios de aceite da Idempotency-Key
- `8699d73` test(sales): cobrir ataques de buyerId unicode e venda travada

Nota: `79bd628` (docs(experiment): regra de decisão, F02 congelada e contexto compartilhado da v2) já estava no branch antes desta rodada e ainda não está em `origin/develop`, então ele entra no diff do PR.

## Left uncommitted
None.

## Pull request
### Recommendation
OPEN NOW
### Reason
- Sinal 2, feature fechada: SHIP; os 13 critérios do build têm teste e nenhum ficou sem cobertura; o Out of scope do spec (expiração de chaves, autenticação, pagamento) e as Notes do build não nomeiam follow-up necessário para a feature ser usada.
- Sinal 3, branch grande: 463 linhas alteradas contra `develop` sem contar a migration SQL (473 no total com ela). Como a feature está fechada, não precisa de draft.
- Sinal 1 não se aplica (feature só de API, sem tela roteável).
- `gh pr view` não achou PR para o branch. Nada foi enviado: o push (`git push -u origin feature/f02-pipeline`) é decisão sua.

### Proposed PR
Title: feat(sales): aceitar Idempotency-Key na compra
Base: develop
Body:
## O que muda
`POST /sales/:id/orders` passa a aceitar o header opcional `Idempotency-Key`. Com a mesma chave, a mesma venda e o mesmo `buyerId`, a API devolve o status e o corpo guardados da primeira requisição, sem criar pedido e sem mexer no estoque. Chave reutilizada com outra venda ou outro comprador → 422 `IDEMPOTENCY_KEY_REUSED`. Requisições simultâneas com a mesma chave criam no máximo um pedido. Sem o header, o comportamento da F01 não muda.

## Commits
- docs(experiment): regra de decisão, F02 congelada e contexto compartilhado da v2
- feat(db): adicionar tabela de chaves de idempotência
- feat(sales): aceitar header Idempotency-Key na compra
- test(sales): cobrir critérios de aceite da Idempotency-Key
- test(sales): cobrir ataques de buyerId unicode e venda travada

## Como foi validado
- Testes unitários: `CI=true pnpm test` exit 0; red check: 18/18 novos testes da F02 falharam antes da implementação.
- Checks estáticos: typecheck 0, lint 0 (0 warnings), build 0.
- E2E: suíte da API (`pnpm test:e2e`, Postgres real) 6 arquivos, 74/74 passando, incluindo os ataques do Verifier. Sem E2E de navegador (feature só de API).
- Review do pipeline: SHIP

## Fora do escopo
- Expiração das chaves, autenticação e pagamento.
