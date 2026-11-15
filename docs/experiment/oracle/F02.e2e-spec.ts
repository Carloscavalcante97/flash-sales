// Oráculo F02, caixa-preta contra a API rodando (ORACLE_URL, padrão http://localhost:3000).
// Só usa o contrato de docs/experiment/features/F02.md (e o da F01). Fica fora do repo até os dois braços entregarem.
const BASE = process.env.ORACLE_URL ?? 'http://localhost:3000';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}

let seq = 0;
const key = () => `k-${process.pid}-${Date.now()}-${++seq}`;
const createSale = async (stock: number) => (await call('POST', '/sales', { name: 'oracle-f02', stock })).body;
const order = (id: string, buyerId: string, k?: string) =>
  call('POST', `/sales/${id}/orders`, { buyerId }, k === undefined ? {} : { 'Idempotency-Key': k });
const stockOf = async (id: string) => (await call('GET', `/sales/${id}`)).body.stock;

function unknownIdLike(id: unknown) {
  const s = String(id);
  if (/^\d+$/.test(s)) return '999999';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '00000000-0000-4000-8000-000000000000';
  return 'oracle-does-not-exist';
}

describe('F02 oráculo', () => {
  it('sem header: comportamento da F01 (duas chamadas, dois pedidos)', async () => {
    const s = await createSale(5);
    const a = await order(s.id, 'b1');
    const b = await order(s.id, 'b1');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.orderId).not.toBe(b.body.orderId);
    expect(await stockOf(s.id)).toBe(3);
  });

  it('mesma chave duas vezes: mesma resposta, um pedido, estoque -1', async () => {
    const s = await createSale(5);
    const k = key();
    const a = await order(s.id, 'b1', k);
    const b = await order(s.id, 'b1', k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toStrictEqual(a.body);
    expect(await stockOf(s.id)).toBe(4);
  });

  it('SOLD_OUT guardado é devolvido de novo', async () => {
    const s = await createSale(1);
    expect((await order(s.id, 'b1', key())).status).toBe(201);
    const k = key();
    const a = await order(s.id, 'b2', k);
    const b = await order(s.id, 'b2', k);
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ error: 'SOLD_OUT' });
    expect(b.status).toBe(409);
    expect(b.body).toStrictEqual(a.body);
  });

  it('chave reutilizada com outro buyerId → 422, sem pedido', async () => {
    const s = await createSale(5);
    const k = key();
    expect((await order(s.id, 'b1', k)).status).toBe(201);
    const r = await order(s.id, 'b2', k);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await stockOf(s.id)).toBe(4);
  });

  it('chave reutilizada em outra venda → 422, sem pedido', async () => {
    const s1 = await createSale(5);
    const s2 = await createSale(5);
    const k = key();
    expect((await order(s1.id, 'b1', k)).status).toBe(201);
    const r = await order(s2.id, 'b1', k);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await stockOf(s2.id)).toBe(5);
  });

  it('400 não é guardado: a mesma chave depois funciona', async () => {
    const s = await createSale(5);
    const k = key();
    expect((await call('POST', `/sales/${s.id}/orders`, {}, { 'Idempotency-Key': k })).status).toBe(400);
    expect((await order(s.id, 'b1', k)).status).toBe(201);
  });

  it('404 não é guardado: a mesma chave depois funciona', async () => {
    const s = await createSale(5);
    const k = key();
    expect((await order(unknownIdLike(s.id), 'b1', k)).status).toBe(404);
    expect((await order(s.id, 'b1', k)).status).toBe(201);
  });

  it.each([
    ['vazia', ''],
    ['256 caracteres', 'a'.repeat(256)],
    ['com espaço', 'a b'],
    ['não ASCII', 'chave-é'],
    ['caractere de controle', 'a\tb'],
  ])('chave inválida (%s) → 400, sem pedido', async (_, k) => {
    const s = await createSale(5);
    expect((await order(s.id, 'b1', k)).status).toBe(400);
    expect(await stockOf(s.id)).toBe(5);
  });

  it('chave com 255 caracteres é válida', async () => {
    const s = await createSale(5);
    expect((await order(s.id, 'b1', 'x'.repeat(255))).status).toBe(201);
  });

  describe('concorrência', () => {
    it('50 requisições simultâneas com a mesma chave → um pedido só', async () => {
      const s = await createSale(10);
      const k = key();
      const rs = await Promise.all(Array.from({ length: 50 }, () => order(s.id, 'b1', k)));
      expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true); // nenhum 500
      const ok = rs.filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThan(0);
      expect(new Set(ok.map((r) => String(r.body.orderId))).size).toBe(1);
      for (const r of rs.filter((r) => r.status === 409)) expect(r.body).toMatchObject({ error: 'IDEMPOTENCY_IN_PROGRESS' });
      expect(await stockOf(s.id)).toBe(9);
      const again = await order(s.id, 'b1', k);
      expect(again.status).toBe(201);
      expect(String(again.body.orderId)).toBe(String(ok[0].body.orderId));
    }, 60_000);

    it('20 chaves × 5 requisições simultâneas → exatamente 20 pedidos', async () => {
      const s = await createSale(100);
      const keys = Array.from({ length: 20 }, key);
      const rs = await Promise.all(keys.flatMap((k, i) => Array.from({ length: 5 }, () => order(s.id, `b${i}`, k).then((r) => ({ k, r })))));
      expect(rs.every(({ r }) => r.status === 201 || r.status === 409)).toBe(true);
      for (const k of keys) {
        const ids = new Set(rs.filter((x) => x.k === k && x.r.status === 201).map((x) => String(x.r.body.orderId)));
        expect(ids.size).toBeLessThanOrEqual(1);
      }
      const all = new Set(rs.filter((x) => x.r.status === 201).map((x) => String(x.r.body.orderId)));
      expect(all.size).toBe(20);
      expect(await stockOf(s.id)).toBe(80);
    }, 60_000);

    it('estoque 5, 20 chaves × 3 simultâneas → 5 pedidos e respostas guardadas coerentes', async () => {
      const s = await createSale(5);
      const keys = Array.from({ length: 20 }, key);
      const rs = await Promise.all(keys.flatMap((k, i) => Array.from({ length: 3 }, () => order(s.id, `b${i}`, k).then((r) => ({ k, r })))));
      expect(rs.every(({ r }) => r.status === 201 || r.status === 409)).toBe(true);
      const all = new Set(rs.filter((x) => x.r.status === 201).map((x) => String(x.r.body.orderId)));
      expect(all.size).toBe(5);
      expect(await stockOf(s.id)).toBe(0);
      let winners = 0;
      for (const [i, k] of keys.entries()) {
        const replay = await order(s.id, `b${i}`, k);
        if (replay.status === 201) winners++;
        else expect(replay.body).toMatchObject({ error: 'SOLD_OUT' });
      }
      expect(winners).toBe(5);
    }, 60_000);
  });
});
