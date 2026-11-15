# Triage (Definition of Ready)
1. Interface explícita: sim — header, valores válidos, status e corpos de cada caso.
2. Regras testáveis: sim — "no máximo um pedido por chave", "estoque −1 por chave", códigos exatos.
3. Delimitado: sim — fora do escopo declarado; só a rota de pedidos.
4. Sem decisão em aberto: sim — o "201 ou 409 IN_PROGRESS" é uma permissão explícita do contrato, não uma escolha pendente.
5. Reversível e local: sim — tabela nova, nenhuma migração de dados existentes.
6. Pequeno: sim — estimativa < 300 linhas sem testes.
Resultado: Planner pulado (DoR atendido); run normal (não large).
