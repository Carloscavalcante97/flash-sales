# Commits

## Status
committed

## Identity
Antônio Carlos Bezerra Cavalcante Junior <antonio.developer@icloud.com> — conta compartilhada: não
(Trocar o nome salvo: `git config --global --unset pipeline.commitAuthor`)

## Branch
feature/f01-pipeline → base do PR: develop (sem remote ainda)

## Commits
- `fe36ce3` feat(db): adicionar modelos Sale e Order com migration
- `ac13123` feat(sales): criar venda e reservar 1 unidade por pedido de forma atômica
- `d066e1f` test(sales): cobrir critérios de aceite e concorrência da reserva
- `090b39f` test(sales): cobrir NUL e casos de ataque; rodar e2e em série

## Left uncommitted
None. (.pipeline/ não foi commitado; baseline estava vazio.)

## Pull request
### Recommendation
OPEN NOW

### Reason
Feature fechada: SHIP, endpoints usáveis, e2e 53/53 passando contra Postgres real. Os únicos NOT COVERED (JSON malformado, falha forçada de DB) são garantias do framework, justificadas no test-results. Branch grande: ~700 linhas (a maior parte em testes). Ainda não há remote: criar o remote antes do PR mode.

### Proposed PR
Title: feat(sales): venda com estoque e reserva atômica de 1 unidade por pedido
Base: develop
Body:
## O que muda
Adiciona o recurso Sale com contador de unidades e o endpoint que reserva exatamente 1 unidade por pedido, sem nunca reservar mais que o estoque sob centenas de requisições concorrentes.

## Commits
- feat(db): adicionar modelos Sale e Order com migration
- feat(sales): criar venda e reservar 1 unidade por pedido de forma atômica
- test(sales): cobrir critérios de aceite e concorrência da reserva
- test(sales): cobrir NUL e casos de ataque; rodar e2e em série

## Como foi validado
- Testes unitários: 1/1 passando
- Checks estáticos: typecheck, lint, build — exit 0
- E2E: all passing, API (NestJS + supertest, Postgres real), 53/53
- Review do pipeline: SHIP

## Fora do escopo
- Ver .pipeline/spec.md
