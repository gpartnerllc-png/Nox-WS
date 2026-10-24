import { HttpError, clientIp, money, num, onlyDigits, str } from './lib/http.js';
import { rateLimit } from './lib/auth.js';
import { buildBusinessSnapshot } from './ai.js';

function dbRequired(env) {
  if (!env.DB) throw new HttpError(503, 'D1 não conectado', 'DB_REQUIRED');
  return env.DB;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calcTaxes(value, icmsPercent = 18) {
  const base = Number(value) || 0;
  const icms = base * (Number(icmsPercent || 18) / 100);
  const pis = base * 0.0165;
  const cofins = base * 0.076;
  const cbs = base * 0.009;
  const ibs = base * 0.001;
  return {
    icms: round2(icms),
    pis: round2(pis),
    cofins: round2(cofins),
    cbs: round2(cbs),
    ibs: round2(ibs),
    totalLegado: round2(icms + pis + cofins),
    ivaDual: round2(cbs + ibs),
  };
}

export async function listProducts(env, url) {
  const db = dbRequired(env);
  const q = str(url.searchParams.get('q'), 80);
  const limit = Math.min(500, Math.max(1, num(url.searchParams.get('limit'), 300, 1, 500)));
  let results;
  if (q) {
    const term = `%${q.replace(/[%_]/g, '\\$&')}%`;
    ({ results } = await db
      .prepare(
        `SELECT * FROM produtos
         WHERE nome LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barras LIKE ? ESCAPE '\\'
         ORDER BY nome LIMIT ?`
      )
      .bind(term, term, term, limit)
      .all());
  } else {
    ({ results } = await db.prepare('SELECT * FROM produtos ORDER BY nome LIMIT ?').bind(limit).all());
  }
  return { ok: true, produtos: results || [] };
}

export async function upsertProduct(env, body) {
  const db = dbRequired(env);
  const sku = str(body.sku, 60) || `SKU-${Date.now().toString(36).toUpperCase()}`;
  const nome = str(body.nome, 160);
  if (!nome) throw new HttpError(400, 'Nome do produto é obrigatório', 'VALIDATION');
  const preco = money(body.preco);
  const estoque = Math.trunc(num(body.estoque, 0, 0, 1e7));
  const icms = num(body.icms, 18, 0, 100);
  await db
    .prepare(
      `INSERT INTO produtos (sku, nome, barras, ncm, cnp, preco, estoque, icms, cfop)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET
         nome = excluded.nome, barras = excluded.barras, ncm = excluded.ncm,
         cnp = excluded.cnp, preco = excluded.preco, estoque = excluded.estoque,
         icms = excluded.icms, cfop = excluded.cfop`
    )
    .bind(
      sku,
      nome,
      str(body.barras, 40) || null,
      str(body.ncm, 20) || null,
      str(body.cnp, 20) || null,
      preco,
      estoque,
      icms,
      str(body.cfop, 10) || '5102'
    )
    .run();
  const produto = await db.prepare('SELECT * FROM produtos WHERE sku = ?').bind(sku).first();
  return { ok: true, produto };
}

export async function removeProduct(env, skuRaw) {
  const sku = str(skuRaw, 60);
  if (!sku) throw new HttpError(400, 'SKU obrigatório', 'VALIDATION');
  const result = await dbRequired(env).prepare('DELETE FROM produtos WHERE sku = ?').bind(sku).run();
  if (!result.meta?.changes) throw new HttpError(404, 'Produto não encontrado', 'NOT_FOUND');
  return { ok: true };
}

export async function listPeople(env) {
  const { results } = await dbRequired(env)
    .prepare('SELECT id, nome, doc, tipo, tel, email, criado_em FROM pessoas ORDER BY id DESC LIMIT 500')
    .all();
  return { ok: true, pessoas: results || [] };
}

export async function upsertPerson(env, body) {
  const db = dbRequired(env);
  const nome = str(body.nome, 160);
  if (!nome) throw new HttpError(400, 'Nome é obrigatório', 'VALIDATION');
  const doc = str(body.doc, 30) || null;
  const tipo = str(body.tipo, 2).toUpperCase() === 'PJ' ? 'PJ' : 'PF';
  const tel = onlyDigits(body.tel) || null;
  const email = str(body.email, 180) || null;
  const id = body.id ? Math.trunc(num(body.id, 0, 0)) : 0;
  let personId = id;
  if (id) {
    const result = await db
      .prepare('UPDATE pessoas SET nome = ?, doc = ?, tipo = ?, tel = ?, email = ? WHERE id = ?')
      .bind(nome, doc, tipo, tel, email, id)
      .run();
    if (!result.meta?.changes) throw new HttpError(404, 'Pessoa não encontrada', 'NOT_FOUND');
  } else {
    const existing = doc
      ? await db.prepare('SELECT id FROM pessoas WHERE doc = ? LIMIT 1').bind(doc).first()
      : null;
    if (existing?.id) {
      personId = existing.id;
      await db
        .prepare('UPDATE pessoas SET nome = ?, doc = ?, tipo = ?, tel = ?, email = ? WHERE id = ?')
        .bind(nome, doc, tipo, tel, email, existing.id)
        .run();
    } else {
      const result = await db
        .prepare('INSERT INTO pessoas (nome, doc, tipo, tel, email) VALUES (?, ?, ?, ?, ?)')
        .bind(nome, doc, tipo, tel, email)
        .run();
      personId = result.meta?.last_row_id || null;
    }
  }
  const pessoa = await db.prepare('SELECT * FROM pessoas WHERE id = ?').bind(personId).first();
  return { ok: true, pessoa };
}

export async function removePerson(env, idRaw) {
  const id = Math.trunc(num(idRaw, 0, 0));
  if (!id) throw new HttpError(400, 'ID inválido', 'VALIDATION');
  const db = dbRequired(env);
  const consumes = await db
    .prepare('SELECT COUNT(*) AS total FROM consumos_hotel WHERE hospede_id = ?')
    .bind(id)
    .first();
  if (Number(consumes?.total || 0) > 0) {
    throw new HttpError(
      409,
      'Esta pessoa possui consumos no hotel. Mantenha o histórico e remova apenas o template biométrico.',
      'PERSON_HAS_HISTORY'
    );
  }
  await db.batch([
    db.prepare('DELETE FROM palm_templates WHERE hospede_id = ?').bind(id),
    db.prepare('DELETE FROM hospede_quarto WHERE hospede_id = ?').bind(id),
    db.prepare('DELETE FROM pessoas WHERE id = ?').bind(id),
  ]);
  return { ok: true };
}

export async function listLeads(env) {
  const { results } = await dbRequired(env)
    .prepare('SELECT id, nome, tel, doc, compras, ultima_compra, valor, criado_em FROM leads ORDER BY id DESC LIMIT 500')
    .all();
  return { ok: true, leads: results || [] };
}

export async function upsertLead(env, body) {
  const db = dbRequired(env);
  const tel = onlyDigits(body.tel);
  if (!tel) throw new HttpError(400, 'Telefone é obrigatório', 'VALIDATION');
  const nome = str(body.nome, 160) || 'Cliente';
  const doc = str(body.doc, 30) || null;
  const registrarCompra = body.registrarCompra === true;
  const valor = money(body.valor);
  const ultimaCompra = str(body.ultimaCompra, 60) || (registrarCompra ? new Date().toISOString() : null);
  const existing = await db.prepare('SELECT * FROM leads WHERE tel = ? LIMIT 1').bind(tel).first();
  if (existing) {
    await db
      .prepare(
        `UPDATE leads SET nome = ?, doc = COALESCE(?, doc),
           compras = compras + ?, ultima_compra = COALESCE(?, ultima_compra),
           valor = CASE WHEN ? > 0 THEN ? ELSE valor END
         WHERE id = ?`
      )
      .bind(nome, doc, registrarCompra ? 1 : 0, ultimaCompra, valor, valor, existing.id)
      .run();
  } else {
    await db
      .prepare(
        'INSERT INTO leads (nome, tel, doc, compras, ultima_compra, valor) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(nome, tel, doc, registrarCompra ? 1 : 0, ultimaCompra, valor)
      .run();
  }
  const lead = await db.prepare('SELECT * FROM leads WHERE tel = ? LIMIT 1').bind(tel).first();
  return { ok: true, lead };
}

export async function listSales(env, url) {
  const limit = Math.min(500, Math.max(1, num(url.searchParams.get('limit'), 200, 1, 500)));
  const { results } = await dbRequired(env)
    .prepare('SELECT * FROM vendas ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all();
  const vendas = (results || []).map((venda) => ({
    ...venda,
    detalhe: (() => {
      try {
        return JSON.parse(venda.detalhe_json || '[]');
      } catch {
        return [];
      }
    })(),
  }));
  return { ok: true, vendas };
}

async function findSaleByClientId(env, clientId) {
  const receipt = await env.DB.prepare('SELECT * FROM sync_receipts WHERE client_id = ?').bind(clientId).first();
  if (!receipt) return null;
  if (receipt.venda_id) {
    return env.DB.prepare('SELECT * FROM vendas WHERE id = ?').bind(receipt.venda_id).first();
  }
  return null;
}

export async function createSale(env, body, user) {
  const db = dbRequired(env);
  const detalheRaw = Array.isArray(body.detalhe) ? body.detalhe.slice(0, 100) : [];
  if (!detalheRaw.length) throw new HttpError(400, 'A venda precisa ter pelo menos um item', 'VALIDATION');
  const clientId = str(body.clientId || body.client_id, 80) || `srv-${crypto.randomUUID()}`;
  const existing = await findSaleByClientId(env, clientId);
  if (existing) {
    return { ok: true, duplicate: true, vendaId: existing.id, total: existing.total };
  }

  const skus = [...new Set(detalheRaw.map((item) => str(item.sku, 60)).filter(Boolean))];
  const products = new Map();
  if (skus.length) {
    const placeholders = skus.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT * FROM produtos WHERE sku IN (${placeholders})`)
      .bind(...skus)
      .all();
    for (const produto of results || []) products.set(produto.sku, produto);
  }

  let total = 0;
  let impostos = 0;
  let cbsIbs = 0;
  let itens = 0;
  const detalhe = [];
  const stockUpdates = [];
  for (const item of detalheRaw) {
    const sku = str(item.sku, 60);
    const product = sku ? products.get(sku) : null;
    const quantidade = Math.max(1, Math.min(9999, Math.trunc(num(item.qtd ?? item.quantidade, 1, 1, 9999))));
    const nome = str(product?.nome || item.nome, 160);
    if (!nome) continue;
    const preco = money(product?.preco ?? item.preco);
    const icmsPercent = num(product?.icms ?? item.icms, 18, 0, 100);
    if (product && Number(product.estoque) < quantidade) {
      throw new HttpError(
        409,
        `Estoque insuficiente para ${product.nome} (disponível: ${product.estoque})`,
        'STOCK_OUT',
        { sku: product.sku, estoque: product.estoque, solicitado: quantidade }
      );
    }
    const lineTotal = round2(preco * quantidade);
    const tax = calcTaxes(lineTotal, icmsPercent);
    total += lineTotal;
    impostos += tax.totalLegado;
    cbsIbs += tax.ivaDual;
    itens += quantidade;
    detalhe.push({
      sku: product?.sku || sku || null,
      nome,
      qtd: quantidade,
      preco,
      icms: icmsPercent,
      ncm: str(product?.ncm || item.ncm, 20),
      cfop: str(product?.cfop || item.cfop, 10) || '5102',
      impostos_novos: { cbs: tax.cbs, ibs: tax.ibs },
      total: lineTotal,
    });
    if (product) {
      stockUpdates.push({ sku: product.sku, quantidade });
    }
  }
  if (!detalhe.length) throw new HttpError(400, 'Nenhum item válido na venda', 'VALIDATION');
  total = round2(total);
  impostos = round2(impostos);
  cbsIbs = round2(cbsIbs);
  const numero = str(body.numero, 30).replace(/[^a-zA-Z0-9.-]/g, '') || `V${Date.now().toString(36).toUpperCase()}`;
  const data = str(body.data, 40) || new Date().toISOString();
  const clienteNome = str(body.clienteNome || body.cliente_nome, 160);
  const clienteTel = onlyDigits(body.clienteTel || body.cliente_tel);

  const statements = [
    db.prepare('INSERT INTO sync_receipts (client_id) VALUES (?)').bind(clientId),
    db
      .prepare(
        `INSERT INTO vendas
           (numero, total, impostos, cbs_ibs, detalhe_json, data, usuario_email, cliente_nome, cliente_tel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        numero,
        total,
        impostos,
        cbsIbs,
        JSON.stringify(detalhe),
        data,
        user?.email || '',
        clienteNome,
        clienteTel
      ),
    ...stockUpdates.map((item) =>
      db.prepare('UPDATE produtos SET estoque = MAX(0, estoque - ?) WHERE sku = ?').bind(item.quantidade, item.sku)
    ),
  ];
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const duplicate = await findSaleByClientId(env, clientId).catch(() => null);
    if (duplicate) {
      return { ok: true, duplicate: true, vendaId: duplicate.id, total: duplicate.total };
    }
    console.error('Falha ao criar venda:', error?.message || error);
    throw new HttpError(500, 'Não foi possível registrar a venda', 'SALE_FAILED');
  }
  const vendaId = results?.[1]?.meta?.last_row_id || null;
  if (vendaId) {
    await db
      .prepare('UPDATE sync_receipts SET venda_id = ? WHERE client_id = ?')
      .bind(vendaId, clientId)
      .run()
      .catch(() => {});
  }
  if (clienteTel) {
    await upsertLead(env, {
      nome: clienteNome || 'Cliente',
      tel: clienteTel,
      valor: total,
      ultimaCompra: data,
      registrarCompra: true,
    }).catch((error) => console.error('Lead da venda falhou:', error?.message || error));
  }
  return {
    ok: true,
    duplicate: false,
    vendaId,
    numero,
    total,
    impostos,
    cbs_ibs: cbsIbs,
    itens,
    clientId,
  };
}

export async function getSync(env) {
  const db = dbRequired(env);
  const [productsRes, salesRes, peopleRes, leadsRes, paymentsRes, frigoRes] = await db.batch([
    db.prepare('SELECT * FROM produtos ORDER BY nome LIMIT 500'),
    db.prepare('SELECT * FROM vendas ORDER BY id DESC LIMIT 300'),
    db.prepare('SELECT id, nome, doc, tipo, tel, email, criado_em FROM pessoas ORDER BY id DESC LIMIT 500'),
    db.prepare('SELECT id, nome, tel, doc, compras, ultima_compra, valor, criado_em FROM leads ORDER BY id DESC LIMIT 500'),
    db.prepare(
      `SELECT id, provider, metodo, status, valor, descricao, cliente_nome, external_id,
              txid, checkout_url, expira_em, venda_id, criado_em, pago_em
       FROM pagamentos ORDER BY id DESC LIMIT 100`
    ),
    db.prepare('SELECT * FROM frigobar_itens WHERE ativo = 1 ORDER BY nome'),
  ]);
  return {
    ok: true,
    syncedAt: new Date().toISOString(),
    produtos: productsRes.results || [],
    vendas: (salesRes.results || []).map((venda) => ({
      ...venda,
      detalhe: (() => {
        try {
          return JSON.parse(venda.detalhe_json || '[]');
        } catch {
          return [];
        }
      })(),
    })),
    pessoas: peopleRes.results || [],
    leads: leadsRes.results || [],
    pagamentos: paymentsRes.results || [],
    frigobar: frigoRes.results || [],
  };
}

export async function getDashboard(env) {
  const db = dbRequired(env);
  const snapshot = await buildBusinessSnapshot(env);
  const [recentesRes, waRes, pagRes, consumoRes] = await db.batch([
    db.prepare('SELECT id, numero, total, impostos, cbs_ibs, data, cliente_nome, detalhe_json FROM vendas ORDER BY id DESC LIMIT 8'),
    db.prepare(
      `SELECT
         COUNT(*) AS conversas,
         COALESCE(SUM(nao_lidas), 0) AS nao_lidas,
         SUM(CASE WHEN ia_ativa = 1 THEN 1 ELSE 0 END) AS com_ia
       FROM wa_conversas WHERE arquivada = 0`
    ),
    db.prepare("SELECT COUNT(*) AS pendentes, COALESCE(SUM(valor),0) AS valor FROM pagamentos WHERE status = 'pendente'"),
    db.prepare('SELECT COUNT(*) AS consumos, COALESCE(SUM(valor),0) AS valor FROM consumos_hotel WHERE date(criado_em) = date(\'now\')'),
  ]);
  return {
    ok: true,
    geradoEm: new Date().toISOString(),
    ...snapshot,
    whatsapp: {
      conversas: Number(waRes.results?.[0]?.conversas || 0),
      nao_lidas: Number(waRes.results?.[0]?.nao_lidas || 0),
      com_ia: Number(waRes.results?.[0]?.com_ia || 0),
    },
    pagamentosPendentes: {
      quantidade: Number(pagRes.results?.[0]?.pendentes || 0),
      valor: money(pagRes.results?.[0]?.valor || 0),
    },
    hotelHoje: {
      consumos: Number(consumoRes.results?.[0]?.consumos || 0),
      valor: money(consumoRes.results?.[0]?.valor || 0),
    },
    ultimasVendas: (recentesRes.results || []).map((venda) => ({
      ...venda,
      detalhe: (() => {
        try {
          return JSON.parse(venda.detalhe_json || '[]');
        } catch {
          return [];
        }
      })(),
    })),
  };
}

async function cachedJson(ctx, env, key, ttl, loader) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://noxmob-cache.internal/${encodeURIComponent(key)}`, { method: 'GET' });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return await cached.json();
    } catch {
      /* cache indisponível */
    }
  }
  const data = await loader();
  if (cache) {
    const response = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
    });
    const promise = cache.put(cacheKey, response).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(promise);
  }
  return data;
}

export async function lookupCnpj(env, ctx, cnpjRaw) {
  const cnpj = onlyDigits(cnpjRaw);
  if (cnpj.length !== 14) throw new HttpError(400, 'CNPJ inválido', 'VALIDATION');
  await rateLimit(env, `cnpj:${cnpj}`, 30, 60);
  const data = await cachedJson(ctx, env, `cnpj:${cnpj}`, 86400, async () => {
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'NoxMob/2.0' },
    });
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, 'CNPJ não encontrado na BrasilAPI', 'CNPJ_LOOKUP_FAILED');
    return response.json();
  });
  return {
    ok: true,
    cnpj,
    razao_social: data.razao_social || '',
    nome_fantasia: data.nome_fantasia || '',
    nome: data.razao_social || data.nome_fantasia || '',
    email: data.email || '',
    telefone: data.ddd_telefone_1 || data.ddd_telefone_2 || '',
    uf: data.uf || '',
    municipio: data.municipio || '',
    bairro: data.bairro || '',
    logradouro: data.logradouro || '',
    numero: data.numero || '',
    cep: data.cep || '',
    cnae: data.cnae_fiscal_descricao || '',
    situacao: data.descricao_situacao_cadastral || '',
    fonte: 'brasilapi',
  };
}

export async function lookupCep(env, ctx, cepRaw, req) {
  const cep = onlyDigits(cepRaw);
  if (cep.length !== 8) throw new HttpError(400, 'CEP inválido', 'VALIDATION');
  await rateLimit(env, `cep:${clientIp(req)}:${cep}`, 60, 60);
  const data = await cachedJson(ctx, env, `cep:${cep}`, 604800, async () => {
    try {
      const response = await fetch(`https://brasilapi.com.br/api/v2/cep/v1/${cep}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'NoxMob/2.0' },
      });
      if (response.ok) {
        const body = await response.json();
        return {
          cep: body.cep || cep,
          rua: body.street || body.logradouro || '',
          bairro: body.neighborhood || body.bairro || '',
          cidade: body.city || body.localidade || '',
          uf: body.state || body.uf || '',
          fonte: 'brasilapi',
        };
      }
    } catch {
      /* tenta ViaCEP */
    }
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      headers: { Accept: 'application/json', 'User-Agent': 'NoxMob/2.0' },
    });
    if (!response.ok) throw new HttpError(502, 'CEP não encontrado', 'CEP_LOOKUP_FAILED');
    const body = await response.json();
    if (body.erro) throw new HttpError(404, 'CEP não encontrado', 'CEP_NOT_FOUND');
    return {
      cep: body.cep || cep,
      rua: body.logradouro || '',
      bairro: body.bairro || '',
      cidade: body.localidade || '',
      uf: body.uf || '',
      fonte: 'viacep',
    };
  });
  return { ok: true, ...data };
}

export async function exportAll(env) {
  const db = dbRequired(env);
  const tables = ['produtos', 'vendas', 'pessoas', 'leads', 'usuarios', 'pagamentos', 'wa_conversas', 'wa_mensagens', 'consumos_hotel', 'frigobar_itens'];
  const statements = tables.map((table) => db.prepare(`SELECT * FROM ${table}`));
  const results = await db.batch(statements);
  const data = {
    exportadoEm: new Date().toISOString(),
    versao: '2.0',
    tabelas: {},
  };
  tables.forEach((table, index) => {
    data.tabelas[table] = results[index].results || [];
  });
  return data;
}
