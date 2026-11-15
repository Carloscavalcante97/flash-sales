# Experimento: pipeline × Claude Code direto

Registrado em 2026-11-15, antes de qualquer feature ser implementada. Mudanças
neste arquivo depois da F01 entram como adendo datado no fim, nunca reescrevendo
o que está acima.

## Pergunta

Quanto retrabalho a pipeline (`/pipeline`: Planner → Coder → Simplifier → Tester
→ Breaker → E2E → Reviewer) evita em comparação com o Claude Code usado direto, e
quanto ela custa a mais?

## Hipóteses

- **H1.** O retrabalho pós-entrega (em linhas) cai pelo menos 30% com a pipeline.
- **H2.** A pipeline passa em mais testes do oráculo na primeira entrega.
- **H3.** A pipeline gasta de 3 a 5 vezes mais tokens e tempo de relógio, mas pede menos minutos de atenção humana.

Se o resultado for negativo, ele também é publicado.

## Desenho

**A/B pareado por feature.** Cada feature do experimento é implementada duas
vezes a partir do mesmo commit (`F0X-base`), uma vez em cada braço, em worktrees
separados. Comparar a mesma feature consigo mesma tira a diferença de dificuldade
entre features, que é o maior fator de confusão num projeto pequeno.

| | braço `direct` | braço `pipeline` |
|---|---|---|
| como roda | sessão nova do Claude Code com o prompt fixo abaixo | sessão nova, `/pipeline <descrição>` |
| modelo | o mesmo nos dois (anotar no ledger) | o mesmo |
| entrada | `docs/experiment/features/F0X.md`, sem alterações | o mesmo arquivo |
| Ponytail global | `PONYTAIL_DEFAULT_MODE=off` | `PONYTAIL_DEFAULT_MODE=off` (o Simplifier carrega a skill sozinho) |
| intervenção humana | só responder perguntas, cada resposta anotada | só os gates da pipeline, cada um anotado |

Prompt fixo do braço `direct`:

```
Implemente a feature descrita abaixo, com testes. Rode typecheck, lint e testes
antes de dizer que terminou.

<conteúdo de docs/experiment/features/F0X.md>
```

**Oráculo oculto.** São testes de aceitação caixa-preta (HTTP contra a API
rodando) que verificam as invariantes da feature. Você escreve o oráculo (ou
revisa linha por linha) antes de rodar qualquer um dos braços e o guarda fora do
repo, em `../flash-sales-oracle/F0X/`, para que nenhum agente o veja. Por isso
toda descrição de feature precisa trazer o contrato da API (rotas, payloads,
status). Sem contrato, o oráculo não tem o que chamar.

## Definições

- **Entrega (`done`)**: no `direct`, quando o Claude diz que terminou e você
  commita. No `pipeline`, quando o Finish dá SHIP e o Committer commita. Marcada
  com a tag `F0X-<braço>-done`.
- **Aceite (`accepted`)**: o oráculo passa 100% e a revisão humana não deixa
  nenhum defeito alto ou médio aberto. Marcado com a tag `F0X-<braço>-accepted`.
- **Retrabalho**: linhas adicionadas + removidas entre `done` e `accepted`, sem
  contar lockfiles, `.pipeline/`, `docs/experiment/` e `test/oracle/`. É
  calculado por `scripts/rework.sh`, não à mão.
- **Rodadas**: número de commits entre `done` e `accepted` (um commit por rodada
  de correção).
- **Redução de retrabalho** = `1 − Σretrabalho_pipeline / Σretrabalho_direct`,
  somando só as features com os dois braços aceitos. A métrica primária usa linhas
  absolutas e não a taxa sobre o entregue: como é a mesma feature, a taxa
  favoreceria o braço que escreve mais código.
- O retrabalho **interno** da pipeline (fix loop antes de entregar) não conta
  como retrabalho pós-entrega. Ele faz parte do custo da pipeline: aparece em
  tokens e tempo e vai para as colunas `caught_*` do ledger.

## Passo a passo por feature

1. **Congele a descrição** em `docs/experiment/features/F0X.md`, com o
   contrato da API, e commite em `develop`.
2. **Escreva o oráculo** em `../flash-sales-oracle/F0X/`, fora do repo.
3. **Crie a base e os worktrees**:
   ```bash
   git tag F0X-base develop
   git worktree add ../fs-F0X-direct   -b feature/f0x-direct   F0X-base
   git worktree add ../fs-F0X-pipeline -b feature/f0x-pipeline F0X-base
   ```
4. **Rode cada braço em uma sessão própria**, um de cada vez (os dois usariam a
   porta 3000). Nas features ímpares o `direct` vai primeiro; nas pares, a
   `pipeline`. Cada worktree usa um banco próprio:
   ```bash
   cd ../fs-F0X-direct && pnpm install
   export DATABASE_URL=postgresql://flash:flash@localhost:55432/f0x_direct
   export REDIS_URL=redis://localhost:56379/1        # pipeline: /2
   PONYTAIL_DEFAULT_MODE=off claude
   ```
   Ao terminar, faça `git tag F0X-direct-done` (ou `F0X-pipeline-done` depois
   do commit do Committer).
5. **Rode o oráculo**: copie-o para `apps/api/test/oracle/` em cada worktree,
   rode `pnpm --filter api test:e2e` e anote os testes aprovados e o total.
6. **Faça a revisão cega**: `scripts/rework.sh blind F0X` gera `A.diff` e
   `B.diff` embaralhados. Revise os dois com o checklist abaixo, anote os
   defeitos no ledger e só então abra o `.key`.
7. **Corrija com o mesmo método nos dois braços**: sessão direta nova no
   worktree, cole as falhas do oráculo e os defeitos da revisão, um commit por
   rodada, até o aceite. Então faça `git tag F0X-<braço>-accepted`.
8. **Registre o custo**: `npx ccusage@latest session` separa por projeto, e cada
   worktree é um projeto. Anote os tokens, os US$, o tempo de relógio e os
   minutos humanos (cronômetro só quando você estiver olhando).
9. **Guarde a evidência**: preencha `ledger.csv` e copie `.pipeline/history/`
   do braço pipeline para `docs/experiment/runs/F0X/`.
10. **Faça o merge do braço `pipeline` em `develop`**. O `direct` fica preservado
    nas tags. Por fim, `git worktree remove` nos dois.

Para ver o resultado parcial a qualquer momento, rode `pnpm rework`.

## Checklist da revisão (igual para A e B)

- Cumpre o contrato da descrição?
- Continua correto sob concorrência?
- Trata os erros sem perder dados?
- Os testes verificam comportamento, ou só o mock?
- Há código que não precisava existir?

Severidade: **alta** (venda além do estoque, perda de dados, pedido duplicado),
**média** (quebra de contrato, erro não tratado), **baixa** (estilo, excesso).

## Features do experimento (A/B)

| id | feature | invariante que o oráculo verifica |
|---|---|---|
| F01 | venda com estoque + compra com reserva atômica | N compras simultâneas com estoque E resultam em exatamente E sucessos |
| F02 | Idempotency-Key no pedido | a mesma chave enviada duas vezes, inclusive ao mesmo tempo, gera 1 pedido e a mesma resposta |
| F03 | expiração da reserva | reserva não paga expira após o TTL e o estoque volta |
| F04 | outbox + RabbitMQ | nenhum pedido fica sem evento, mesmo com o worker derrubado no meio |
| F05 | saga com compensação | pagamento recusado cancela o pedido e devolve o estoque |
| F06 | sala de espera | nunca há mais que N tokens ativos, e a posição na fila só diminui |
| F07 | retry + DLQ | falha transitória se resolve com retry; falha permanente vai para a DLQ; o reprocessamento funciona |

Ficam fora do A/B (só pipeline, com métricas internas): SSE/UI da fila, painel
admin, observabilidade, k6 e CI. São features sem invariante objetiva para o
oráculo verificar.

## Métricas internas da pipeline

Para cada run, tiradas de `.pipeline/history/<run>/` e anotadas no ledger:

- `caught_tester`, `caught_breaker`, `caught_e2e`, `caught_reviewer`: quantas
  iterações do fix loop cada estágio disparou. Mostram onde a pipeline pegou o
  problema antes de você ver.
- `verdict`: o veredito final do Reviewer.

## Ameaças à validade (repetir no README)

- **Amostra pequena (n = 7).** É estudo de caso, então nada de p-valor. Mostrar a
  tabela feature por feature, não só o total.
- **A mesma pessoa escreve o oráculo e revisa.** Mitigação: o oráculo é escrito
  antes e a revisão é cega.
- **A cegueira é imperfeita.** O diff da pipeline costuma ter mais testes e dá
  para reconhecer.
- **Efeito de aprendizado entre features.** O pareamento na mesma feature
  neutraliza; a ordem dos braços alterna.
- **As correções usam o mesmo método nos dois braços.** Isso mede o retrabalho
  que sobrou, não quem corrige melhor.

## Adendo 2026-11-15: como a F01 foi executada

Desvios do roteiro acima, todos aplicados igualmente aos dois braços:

- **Os braços rodaram como subagentes do Claude Code na mesma sessão**, não em
  sessões novas. O `direct` foi um único subagente `general-purpose` com o prompt
  fixo, mais a linha "Não faça commit". O `pipeline` foram os subagentes do
  `/pipeline`. Os dois rodaram em sequência, em branches no mesmo diretório e não
  em worktrees. Entre um braço e outro o banco foi zerado e o `node_modules` e o
  client do Prisma foram regenerados.
- **Assimetria:** o subagente do `direct` não consegue fazer perguntas ao humano;
  a pipeline consegue, pelos gates do Planner.
- **Ponytail global ligado nos dois braços.** O plugin injeta as regras em todo
  subagente, então os dois receberam a mesma injeção.
- **O oráculo foi escrito pelo Claude**, a partir só do contrato da F01, antes de
  existir qualquer implementação. O ideal é que seja escrito ou revisado por
  você; é uma ameaça à validade desta rodada.
- **A revisão cega foi feita por um subagente novo** que recebeu só `A.diff`,
  `B.diff`, a descrição e o checklist, sem saber qual braço é qual. Você confirma
  depois.
- **O custo vem do relatório de uso de cada subagente** (tokens e duração). O
  `ccusage` não separa subagentes de uma mesma sessão.

## Adendo 2026-11-15 (2): pipeline v2

- **Mudança de tratamento.** A partir da F02, o braço `pipeline` usa o
  `/pipeline-v2` (desenho e fontes em [PIPELINE-V2.md](PIPELINE-V2.md)). A F01
  fica como a única medição da v1.
- **H4.** A v2 gasta no máximo 40% dos tokens da v1 com a mesma qualidade:
  oráculo na 1ª entrega igual ou melhor e nenhum defeito alto ou médio na
  revisão cega depois do aceite.
- **Validação proposta antes da F02.** Rodar a F01 de novo com a v2, a partir de
  `F01-base`, como braço `pipeline-v2`. Isso dá a comparação direta com a v1 e
  com o direct na mesma feature.
- **Oráculo da F02 em diante:** passa a incluir entradas hostis (lição da F01).
- **Fonte de custo:** o `.pipeline/usage.csv` de cada run, gravado pelo
  orquestrador.
