# Flash Sales

[English](README.md) · [Deutsch](README.de.md) · **Português**

Um backend para flash sales: estoque limitado, centenas de compradores
apertando "comprar" no mesmo segundo e uma regra que não pode quebrar: nunca
vender mais do que existe.

O repositório também é um experimento medido. Cada feature é construída duas
vezes, uma por uma pipeline de entrega com vários agentes de IA e outra pelo
Claude Code usado direto, e as duas são comparadas em retrabalho, defeitos e
custo.

## Por que este projeto

Flash sale é um domínio pequeno com problemas difíceis: condição de corrida no
estoque, requisições repetidas que não podem gerar pedido duplicado, reservas
que expiram e eventos que precisam sobreviver à queda de um worker. Cada
feature do roadmap ataca um desses problemas e vem com uma invariante que um
teste caixa-preta consegue verificar.

O segundo objetivo é responder uma pergunta com dados, e não com opinião: uma
pipeline de IA com agentes de planejamento, código, teste e revisão reduz mesmo
o retrabalho em comparação com um agente só? E quanto isso custa? O protocolo,
as hipóteses e a regra de decisão foram registrados antes da primeira feature.
Resultado negativo também é publicado.

## Status

| ID | Feature | Invariante que o oráculo verifica | Status |
|---|---|---|---|
| F01 | Venda com estoque + reserva atômica | N compras simultâneas com estoque E resultam em exatamente E sucessos | pronta |
| F02 | `Idempotency-Key` no pedido | a mesma chave enviada duas vezes, inclusive ao mesmo tempo, gera 1 pedido e a mesma resposta | em andamento |
| F03 | Expiração da reserva | reserva não paga expira após o TTL e o estoque volta | planejada |
| F04 | Outbox transacional + RabbitMQ | nenhum pedido fica sem evento, mesmo com o worker derrubado no meio | planejada |
| F05 | Saga com compensação | pagamento recusado cancela o pedido e devolve o estoque | planejada |
| F06 | Sala de espera | nunca há mais que N tokens ativos, e a posição na fila só diminui | planejada |
| F07 | Retry + DLQ | falha transitória se resolve com retry; falha permanente vai para a DLQ; o reprocessamento funciona | planejada |

## Stack

- TypeScript 6 no Node.js 24, NestJS 12 (ESM)
- PostgreSQL 17 via Prisma 7 (driver adapter `@prisma/adapter-pg`)
- Redis 7 (já no Docker Compose, ainda sem uso)
- Vitest 4 + Supertest para testes e2e contra banco real
- oxlint (type-aware) e Prettier
- Workspaces do pnpm 11 + Turborepo
- Docker Compose para a infraestrutura local

## Como funciona a reserva atômica (F01)

O bug clássico é ler, conferir e gravar: ler o estoque, conferir se é maior
que zero e gravar `stock - 1`. Duas requisições leem `stock = 1` no mesmo
instante, as duas passam na conferência e uma unidade é vendida duas vezes.

Aqui a reserva é um único statement SQL
([`sales.service.ts`](apps/api/src/sales.service.ts)):

```sql
WITH reserved AS (
  UPDATE sales SET stock = stock - 1
  WHERE id = $saleId AND stock > 0
  RETURNING id
)
INSERT INTO orders (id, "saleId", "buyerId")
SELECT $orderId, id, $buyerId FROM reserved;
```

- O `UPDATE` trava a linha. Requisições simultâneas para a mesma venda esperam
  nessa trava e, quando cada uma consegue, o Postgres confere de novo
  `stock > 0` na versão mais recente da linha. O estoque nunca fica negativo.
- O decremento e o insert estão no mesmo statement, então os dois confirmam ou
  falham juntos, sem transação interativa e com uma única ida ao banco.
- Quando nenhuma linha é inserida, o service separa "venda não existe" (`404`)
  de "esgotado" (`409 SOLD_OUT`).

Por que não as alternativas de sempre:

- `SELECT ... FOR UPDATE` numa transação interativa também é correto, mas
  segura a trava por várias idas e voltas ao banco.
- Um contador no Redis é rápido, mas aí o estoque passa a morar em dois lugares
  que podem divergir.

### Testes

A suíte e2e roda contra o Postgres real do Docker Compose, sem mocks. Entre os
casos:

- 200 pedidos simultâneos com estoque 50: exatamente 50 × `201` com `orderId`
  distintos, 150 × `409`, estoque final 0 e 50 linhas em `orders`
- 100 pedidos simultâneos com estoque 1: exatamente um sucesso
- pedidos simultâneos intercalados em duas vendas: o estoque de uma não vaza
  para a outra
- entrada hostil: byte NUL no path e no body (antes virava `500`, porque o
  Postgres rejeita `0x00` em texto) e SQL injection no `buyerId`, que é gravado
  literalmente

## API

| Método | Rota | Body | Respostas |
|---|---|---|---|
| `POST` | `/sales` | `{ "name": string, "stock": inteiro ≥ 1 }` | `201 { id, name, stock }` · `400` |
| `GET` | `/sales/:id` | nenhum | `200 { id, name, stock }` · `404` |
| `POST` | `/sales/:id/orders` | `{ "buyerId": string }` | `201 { orderId, status: "RESERVED" }` · `409 { error: "SOLD_OUT" }` · `404` · `400` |

## Como rodar localmente

Você precisa de Node.js 24, pnpm 11 e Docker.

```bash
docker compose up -d                          # Postgres em :55432, Redis em :56379
pnpm install                                  # também gera o client do Prisma
pnpm --filter api exec prisma migrate deploy  # cria as tabelas
pnpm --filter api start:dev                   # API em http://localhost:3000
```

Não precisa de `.env`: sem ele, a aplicação usa o banco do Docker Compose. Para
apontar para outro, defina `DATABASE_URL`.

```bash
curl -s -X POST localhost:3000/sales \
  -H 'content-type: application/json' -d '{"name":"Tênis","stock":2}'
curl -s -X POST localhost:3000/sales/<id>/orders \
  -H 'content-type: application/json' -d '{"buyerId":"alice"}'
```

Verificações:

```bash
pnpm typecheck
pnpm lint
pnpm --filter api test:e2e   # precisa do docker compose up
```

## O experimento: pipeline de IA × Claude Code direto

**Pergunta.** Quanto retrabalho pós-entrega uma pipeline multiagente (Planner →
Coder → Simplifier → Tester → Breaker → E2E → Reviewer) evita em comparação
com o Claude Code usado direto, e quanto ela custa a mais?

**Hipóteses, registradas antes.** H1: o retrabalho cai pelo menos 30% com a
pipeline. H2: a pipeline passa em mais testes do oráculo na primeira entrega.
H3: a pipeline gasta de 3 a 5 vezes mais tokens e tempo de relógio, mas pede
menos minutos de atenção humana.

**Desenho.**

- A/B pareado por feature: os dois braços partem do mesmo commit (tag
  `F0X-base`), com o mesmo modelo e a mesma descrição congelada da feature.
- Oráculo oculto: testes de aceitação caixa-preta via HTTP, escritos antes de
  qualquer braço rodar e guardados fora do repositório para que nenhum agente
  os veja.
- Revisão cega: `scripts/rework.sh blind F0X` embaralha os dois diffs em A e B,
  e os defeitos são anotados antes de abrir a chave.
- Retrabalho são as linhas adicionadas mais as removidas entre as tags `done` e
  `accepted`, calculadas por `pnpm rework`, nunca à mão.
- Regra de decisão, fixada antes da F02: a pipeline só conta como ganho real
  se, da F02 à F07, entregar com menos defeitos que o braço direto em pelo
  menos metade das features, gastando no máximo 2,5 vezes os tokens.

### Resultados da F01

| | direct | pipeline |
|---|---:|---:|
| oráculo na 1ª entrega | 14/14 | 14/14 |
| defeitos na revisão cega (alta/média/baixa) | 1/0/0 | 0/0/3 |
| retrabalho até o aceite (linhas ±) | 18 | 0 |
| rodadas de correção | 1 | 0 |
| linhas entregues: produção / testes | 132 / 125 | 127 / 486 |
| tokens até o aceite | 154.690 | 951.306 |
| tempo de relógio até o aceite | 3,8 min | 36,1 min |

O que dá para dizer até aqui:

- A etapa adversarial da pipeline (o Breaker) achou o único bug real: um byte
  NUL na entrada virava `500`. O braço direto entregou esse bug, e o oráculo
  também não pegou.
- H1 se confirma na letra (18 linhas contra 0), H2 não (empate em 14/14) e H3
  subestimou o custo: 6,2 vezes mais tokens e 9,4 vezes mais tempo de relógio.
  Metade disso foi para os fix loops, e um deles só consertou uma suíte
  instável que a própria pipeline tinha criado.
- n = 1. Nada se generaliza ainda.

Esses números levaram à **pipeline v2**: um Builder que faz TDD num contexto só
e um Verifier independente que ataca a API rodando. O Planner e as outras
etapas só entram quando o gatilho de cada uma dispara. Nova hipótese H4: a v2
gasta no máximo 40% dos tokens da v1 com a mesma qualidade.

### Ameaças à validade

- **Amostra pequena (n = 7 features).** É estudo de caso: os resultados
  aparecem feature por feature, sem p-valor.
- **A mesma pessoa escreve o oráculo e revisa.** A mitigação é escrever o
  oráculo antes e revisar às cegas. Na F01 o oráculo foi escrito pelo Claude e
  não tinha casos de entrada hostil; da F02 em diante, tem.
- **A cegueira é imperfeita.** O diff da pipeline costuma ter mais testes e dá
  para reconhecer.
- **Aprendizado entre features.** O pareamento na mesma feature neutraliza, e a
  ordem dos braços alterna.
- **O custo da F01 está subestimado.** Os minutos humanos não foram medidos, e
  os tokens do orquestrador da pipeline ficaram fora da conta.

Documentação completa: [protocolo](docs/experiment/PROTOCOL.md),
[resultados](docs/experiment/RESULTS.md),
[pipeline v2](docs/experiment/PIPELINE-V2.md) e
[dados brutos](docs/experiment/ledger.csv).

## Estrutura do repositório

```
apps/api/              API NestJS
  src/sales.*.ts       controller e service da F01
  prisma/              schema e migrations
  test/                testes e2e contra o Postgres real
docs/experiment/       protocolo, specs das features, resultados, ledger e evidências das runs
scripts/rework.sh      métricas de retrabalho e exportação para a revisão cega
docker-compose.yml     Postgres 17 + Redis 7 para desenvolvimento local
```

## Convenções

- **Git flow.** `main` guarda as releases, `develop` integra, e cada feature
  vive numa branch `feature/*` mergeada com `--no-ff`.
- **Conventional Commits.** O corpo do commit explica o porquê, não só o quê.
- **Comentários `ponytail:`** marcam simplificações deliberadas e dizem quando
  vale evoluí-las, por exemplo a validação inline até os bodies crescerem.
