# Pipeline v2

Arquivos: `~/.claude/commands/pipeline-v2.md`, `~/.claude/agents/builder.md` e
`~/.claude/agents/verifier.md`. A v1 (`/pipeline`) continua intacta. A v2
reaproveita os agentes da v1 (planner, simplifier, e2e-tester, reviewer,
committer e pr-creator) só quando o gatilho de cada um dispara.

## Fluxo

```
Triagem (orquestrador, sem agente)
  → [Planner: só se o pedido não passar no Definition of Ready]
  → Builder (TDD num contexto só: testes → red check → código → checks → testes novos 3×)
  → [Simplifier: só se o diff de produção passar de 300 linhas]
  → [E2E: só se mexer em UI ou mobile]
  → Verifier (contexto limpo: até 3 ataques contra a API rodando + revisão contra o spec)
  → [Reviewer: só em runs grandes]
  → fix loop (no máximo 2; automático para bug, humano para lacuna de spec)
  → Committer (Haiku)
```

**Pular o Planner.** O orquestrador responde 6 perguntas sobre o pedido:
interface explícita, regras testáveis, escopo delimitado, nenhuma decisão em
aberto, mudança reversível e local, e tamanho de até ~500 linhas. Se todas forem
"sim", o próprio pedido vira o spec. O pedido da F01 passaria.

## O que mudou e por quê

| mudança | o que a F01 mostrou | evidência externa |
|---|---|---|
| Triagem por Definition of Ready, com Planner só quando o pedido falha | o Planner gastou 86k e escreveu um spec de 240 linhas, relido 12 vezes | O Codex recomenda planejar só se a tarefa for "complexa, ambígua ou difícil de descrever" ([guia](https://learn.chatgpt.com/guides/best-practices)). O BMAD tem um "light path" para pedidos claros ([docs](https://docs.bmad-method.org/plan/choose-a-planning-path/)). No ChatDev, input é 54% dos tokens ([Tokenomics, 2026](https://arxiv.org/abs/2601.14470)) |
| Coder, Simplifier e Tester viram um **Builder** com TDD num contexto só | o Simplifier rodou 3 vezes sem mudar nada (123k), e o red check precisava de worktree | Cursor, Spec Kit e a doc do Claude Code mantêm planejar, implementar e testar no mesmo contexto ([sub-agents](https://code.claude.com/docs/en/sub-agents), [Cursor](https://cursor.com/blog/agent-best-practices)) |
| Breaker, E2E de backend e Reviewer viram um **Verifier** com contexto limpo, que ataca e julga | o Breaker achou o único bug real; o E2E repetiu o Tester; o Reviewer só achou problemas menores | Testes escritos por um agente independente acertam 87,8% contra 61% ([AgentCoder](https://arxiv.org/abs/2312.13010)). Um avaliador cético separado funciona melhor que a autoavaliação ([Anthropic, 2026](https://www.anthropic.com/engineering/harness-design-long-running-apps)). Um juiz que roda o workspace concorda com humanos em ~90%, contra ~70% sem rodar ([Agent-as-a-Judge](https://arxiv.org/abs/2410.10934)) |
| Testes isolados por dados próprios, e testes novos rodados 3 vezes | o fix 2 inteiro (173k) consertou uma instabilidade criada pela própria pipeline | Testes escritos por LLM são mais instáveis, e 63% dos casos dependem de ordem ([ICSE-SEIP 2026](https://arxiv.org/abs/2601.08998)) |
| Cada fix roda num contexto novo, automático para bug e humano para lacuna de spec, com teto de 2 | — | Modelos perdem 60–80% da capacidade de depurar em 2–3 tentativas ([DDI](https://arxiv.org/abs/2506.18403)). Gerar de novo empata ou supera o autorreparo ([Olausson, ICLR 2024](https://arxiv.org/abs/2306.09896)) |
| Committer em Haiku, e Reviewer só em runs grandes | o Committer gastou 25k | A Anthropic recomenda Haiku para subagentes simples ([costs](https://code.claude.com/docs/en/costs)). Só 31% dos PRs com menos de 50 linhas recebem algum achado, contra 84% dos PRs com mais de 1000 ([Claude Code Review](https://claude.com/blog/code-review)) |
| Handoffs com limite de tamanho, mensagem final de até 8 linhas e `omitClaudeMd` | 15 relatórios longos voltaram para o orquestrador | Subagentes devem devolver "referências leves" ([Anthropic, multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)) |
| `usage.csv` gravado automaticamente e orçamento de 450k/800k | a medição da F01 foi manual | Runs que falham custam de 3 a 4,8 vezes mais ([SWE-Effi](https://arxiv.org/abs/2509.09853)) |

Contexto geral: sistemas multi-agente gastam cerca de 15 vezes os tokens de um
chat, e a maior parte das tarefas de código não se paraleliza bem
([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)).
Em tarefas sequenciais, as variantes multi-agente pioraram de 39% a 70%
([Google/MIT](https://arxiv.org/abs/2512.08296)). Pipelines simples como o
Agentless já superaram agentes complexos a US$ 0,70 por issue
([Agentless](https://arxiv.org/abs/2407.01489)).

## Estimativa para a F01 (falta medir)

| | chamadas de agente | tokens | tempo |
|---|---:|---:|---:|
| direct (medido) | 2 | 155k | 4 min |
| pipeline v1 (medido) | 16 | 951k | 36 min |
| pipeline v2 (estimado) | 5 | ~300k | ~12–15 min |

As 5 chamadas da v2 seriam: Builder, Verifier (que acha o NUL), Builder em modo
fix, Verifier em recheck e Committer.

## Riscos conhecidos

- **O Builder escreve os testes e o código.** Isso pode criar viés de oráculo,
  com asserções que copiam o comportamento do código
  ([estudo](https://arxiv.org/abs/2410.21136)). Mitigação: os testes saem do
  spec e são escritos antes do código, e o Verifier é independente.
- **A triagem é feita pelo orquestrador** e pode aprovar um pedido fraco. O
  Builder ainda pode parar com `stopped: open question`.
- **O fix automático tira um gate humano.** O gate de commit continua.

## Ficou de fora (e quando reconsiderar)

- **Verifier com modelo de outra família.** Dois modelos errando tendem a dar a
  mesma resposta errada em ~60% dos casos
  ([ICML 2025](https://arxiv.org/abs/2506.07962)). Reconsiderar se aparecerem
  defeitos que escapam em sequência.
- **Mutation testing** ([Meta ACH](https://arxiv.org/abs/2501.12862)).
  Reconsiderar se o oráculo pegar algo que o Verifier deixou passar.
