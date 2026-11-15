# Resultados do experimento

Protocolo e hipóteses em [PROTOCOL.md](PROTOCOL.md). Os dados brutos estão em
[ledger.csv](ledger.csv), e os números de retrabalho saem de `pnpm rework`.

## F01: venda com estoque + reserva atômica (2026-11-15)

| | direct | pipeline |
|---|---:|---:|
| oráculo na 1ª entrega | 14/14 | 14/14 |
| defeitos na revisão cega (alta/média/baixa) | 1/0/0 | 0/0/3 |
| retrabalho até o aceite (linhas ±) | 18 | 0 |
| rodadas de correção | 1 | 0 |
| linhas entregues: produção / testes | 132 / 125 | 127 / 486 |
| tokens até o aceite | 154.690 | 951.306 |
| tempo de relógio até o aceite | 3,8 min | 36,1 min |
| intervenções humanas no meio da run | 0 | 2 |

### Hipóteses

- **H1, retrabalho ≥ 30% menor: confirmada na letra.** Foram 18 linhas contra
  0 (100%). Mas é uma feature só e uma correção de 18 linhas, então não dá para
  generalizar.
- **H2, mais aprovação no oráculo: não confirmada.** Empate em 14/14. O oráculo
  não tinha casos de entrada hostil, e foi aí que os braços se diferenciaram.
- **H3, custo de 3 a 5 vezes maior: o custo passou da previsão.** Foram 6,2 vezes
  mais tokens e 9,4 vezes mais tempo de relógio, sem contar os tokens do
  orquestrador.

### Onde a pipeline pegou problemas antes da entrega

| estágio | o que pegou | valeu? |
|---|---|---|
| Breaker | byte NUL em `:id`, `name` e `buyerId` virava 500 | **sim.** É o mesmo defeito que o `direct` entregou e que o oráculo não pegou |
| Tester (fix 1) | a suíte de e2e ficou instável | não. A instabilidade foi criada pelos próprios testes da pipeline: o Tester do fix 1 adicionou um arquivo que o plano não pedia, e as contagens globais da iteração 0 começaram a disputar com ele |
| Reviewer | SHIP com 3 achados baixos | parcial. Todos os achados são sobre testes redundantes |
| gate de status | o Coder escreveu `implemented (fix cycle iteration 1)` | sim, como processo. O gate exato barrou um status fora do contrato |

### Vantagens reais desta rodada

- O Breaker encontrou uma entrada hostil que nem o braço direto nem o oráculo
  cobriam. Sem a pipeline, esse 500 teria passado da entrega.
- Os gates seguraram dois desvios de processo: o status fora do contrato e a
  suíte instável. Nada disso chegou ao commit.

### Custos e excessos desta rodada

- Cerca de 6 vezes mais tokens e 9 vezes mais tempo de relógio. Metade do custo
  foi para as duas iterações do fix loop, e uma delas só existiu para corrigir
  problema causado pela própria pipeline.
- Quase 4 vezes mais linhas de teste para praticamente o mesmo código de
  produção. O revisor cego estimou cerca de 190 linhas desnecessárias na pipeline
  e cerca de 6 no `direct`.
- O Simplifier rodou numa mudança de uma linha de config: 32 mil tokens para
  concluir "nada a fazer".
- O E2E reaproveitou os testes em processo e não subiu a API de verdade.

### Ameaças à validade específicas da F01

- **Vazamento na revisão lado a lado.** O revisor provavelmente só procurou NUL
  no `direct` porque viu os testes de NUL da pipeline. O vazamento ajudou a
  medir: sem ele, os dois braços empatariam em zero e o defeito do `direct`
  ficaria escondido.
- **O oráculo foi escrito pelo Claude e não cobria entrada hostil.** Da F02 em
  diante, o oráculo precisa ter casos de entrada maliciosa.
- **n = 1.** É uma feature só.
- **Os minutos humanos não foram medidos**, e os tokens do orquestrador da
  pipeline (a sessão principal) ficaram fora da conta. O custo real da pipeline
  é maior que o da tabela.

### Ajustes sugeridos na pipeline (para avaliar antes da F02)

1. Pular o Simplifier quando o fix não toca em código de produção.
2. Fazer o Tester em modo fix respeitar "Changes for the Tester: None", sem
   adicionar arquivo novo.
3. Exigir que testes de "nenhuma linha nova" contem só as linhas do próprio
   teste, nunca a tabela inteira.
4. Fazer o E2E de backend subir a API de verdade.

Mudar a pipeline no meio do experimento altera o tratamento. Se algum ajuste for
aplicado, ele entra como adendo datado no PROTOCOL e vale a partir da feature
seguinte.

## F02: Idempotency-Key, pipeline v2 contra direct (2026-11-15)

| | direct | pipeline v2 |
|---|---:|---:|
| oráculo na 1ª entrega | 16/16 | 16/16 |
| defeitos na revisão cega (alta/média/baixa) | 0/**1**/0 | 0/0/1 |
| retrabalho até o aceite (linhas ±) | 27 | 0 |
| rodadas de correção | 1 | 0 |
| tokens até o aceite | 201.302 | 203.618 (+38.568 do Committer em Haiku) |
| tempo de relógio até o aceite | 9,5 min | 17,9 min |
| intervenções humanas no meio da run | 0 | 1 |
| chamadas de agente | 2 | 4 (Builder, Verifier, Builder retomado, Verifier retomado) |
| vazão com chave (exploratório) | ~1.320 req/s, p99 ~730 ms | ~1.040 req/s, p99 ~940 ms |

**Defeito do direct:** um `buyerId` com surrogate UTF-16 solto fazia a repetição
idêntica receber 422 em vez do 201 guardado. Um cliente que trata 422 gerando uma
chave nova acabaria criando um segundo pedido. O Verifier da v2 pegou esse caso
antes da entrega.

**O que a v2 errou:** o Builder escolheu uma transação interativa com timeout de
5 s. Isso criou um 500 sob trava longa que o direct nunca teve, porque o direct
faz tudo numa única instrução SQL. O Verifier pegou o problema e o fix
(`timeout: 2^31-1`) resolveu, mas o desenho da v2 terminou com cerca de 22% menos
vazão nas compras com chave. O Builder também repetiu o deslize de status fora do
contrato (corrigido no `builder.md` depois desta run).

**Custo:** pela soma do contexto final de cada agente, a v2 gastou praticamente o
mesmo que o direct (1,0x), contra 6,2x da v1 na F01. O tempo de relógio ainda é
1,9x o do direct. Ressalva: nos agentes retomados, o número registrado é o
contexto final; o custo real de processamento de cada turno fica subestimado.

**Ressalva de validade:** como na F01, o revisor cego provavelmente procurou o
surrogate no direct porque os testes de ataque da v2 apontavam para ele.

## Placar parcial (regra de decisão do adendo 3)

| feature | menos defeitos | tokens da pipeline ÷ direct |
|---|---|---:|
| F01 (v1, antes da regra) | pipeline | 6,2x |
| F02 (v2) | pipeline | 1,0x |

**Parcial: 1 de 1 feature da v2 a favor da pipeline, dentro do limite de 2,5x.**
Pela regra registrada, ainda não há conclusão: são necessárias pelo menos 3
features no A/B.
