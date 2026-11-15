// Oráculo F01, caixa-preta contra a API rodando (ORACLE_URL, padrão http://localhost:3000).
// Só usa o contrato de docs/experiment/features/F01.md. Fica fora do repo até os dois braços entregarem.
const BASE = process.env.ORACLE_URL ?? 'http://localhost:3000';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}

const createSale = (stock: unknown, name: unknown = 'oracle') => call('POST', '/sales', { name, stock });
const order = (id: string, buyerId: string) => call('POST', `/sales/${id}/orders`, { buyerId });

// id inexistente no mesmo formato que a implementação usa (int, uuid ou texto)
function unknownIdLike(id: unknown) {
  const s = String(id);
  if (/^\d+$/.test(s)) return '999999';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '00000000-0000-4000-8000-000000000000';
  return 'oracle-does-not-exist';
}

describe('F01 oráculo', () => {
  describe('POST /sales', () => {
    it('cria a venda e devolve id, name e stock', async () => {
      const r = await createSale(10, 'Ingresso A');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ name: 'Ingresso A', stock: 10 });
      expect(r.body.id).toBeDefined();
    });

    it.each([
      ['stock 0', { name: 'x', stock: 0 }],
      ['stock negativo', { name: 'x', stock: -1 }],
      ['stock fracionário', { name: 'x', stock: 1.5 }],
      ['sem name', { stock: 10 }],
      ['sem stock', { name: 'x' }],
    ])('400 com %s', async (_, body) => {
      expect((await call('POST', '/sales', body)).status).toBe(400);
    });
  });

  describe('GET /sales/:id', () => {
    it('devolve a venda', async () => {
      const s = (await createSale(5, 'Ingresso B')).body;
      const r = await call('GET', `/sales/${s.id}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ name: 'Ingresso B', stock: 5 });
      expect(String(r.body.id)).toBe(String(s.id));
    });

    it('404 para venda inexistente', async () => {
      const s = (await createSale(1)).body;
      expect((await call('GET', `/sales/${unknownIdLike(s.id)}`)).status).toBe(404);
    });
  });

  describe('POST /sales/:id/orders', () => {
    it('reserva 1 unidade', async () => {
      const s = (await createSale(3)).body;
      const r = await order(s.id, 'buyer-1');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'RESERVED' });
      expect(r.body.orderId).toBeDefined();
      expect((await call('GET', `/sales/${s.id}`)).body.stock).toBe(2);
    });

    it('409 SOLD_OUT quando acaba, sem estoque negativo', async () => {
      const s = (await createSale(1)).body;
      expect((await order(s.id, 'b1')).status).toBe(201);
      const r = await order(s.id, 'b2');
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'SOLD_OUT' });
      expect((await call('GET', `/sales/${s.id}`)).body.stock).toBe(0);
    });

    it('404 para venda inexistente', async () => {
      const s = (await createSale(1)).body;
      expect((await order(unknownIdLike(s.id), 'b1')).status).toBe(404);
    });

    it('400 sem buyerId', async () => {
      const s = (await createSale(1)).body;
      expect((await call('POST', `/sales/${s.id}/orders`, {})).status).toBe(400);
    });
  });

  describe('concorrência', () => {
    it.each([
      [50, 300],
      [1, 100],
    ])('estoque %i com %i compras simultâneas → exatamente E sucessos', async (stock, n) => {
      const s = (await createSale(stock)).body;
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => order(s.id, `buyer-${i}`)));
      const ok = rs.filter((r) => r.status === 201);
      expect(ok).toHaveLength(stock);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(n - stock); // nenhum 500
      expect(new Set(ok.map((r) => String(r.body.orderId))).size).toBe(stock);
      expect((await call('GET', `/sales/${s.id}`)).body.stock).toBe(0);
    }, 60_000);
  });
});
