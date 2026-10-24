import {
  HttpError,
  clientIp,
  money,
  num,
  onlyDigits,
  readJson,
  str,
} from './lib/http.js';
import { audit, enforceRateLimit, requireAuth } from './lib/auth.js';
import { encryptSensitive, sha256Hex, timingSafeEqual } from './lib/security.js';
import { createInterPix, interConfigured } from './providers/inter.js';

function dbRequired(env) {
  if (!env.DB) throw new HttpError(503, 'D1 não conectado', 'DB_REQUIRED');
  return env.DB;
}

export async function hotelGuard(req, env, { manager = false } = {}) {
  const hotelKey = String(env.HOTEL_API_KEY || '');
  const received = req.headers.get('X-Hotel-Key') || req.headers.get('X-API-Key') || '';
  if (hotelKey && received && timingSafeEqual(received, hotelKey)) {
    return { email: 'hotel-device', nome: 'Dispositivo Hotel', papel: 'operador', via: 'hotel-key' };
  }
  try {
    return await requireAuth(req, env, manager ? ['admin', 'gerente'] : null);
  } catch (error) {
    if (env.HOTEL_ALLOW_ANON === 'true' && !manager) {
      await enforceRateLimit(env, `hotel-anon:${clientIp(req)}`, 240, 60);
      return { email: 'hotel-anonimo', nome: 'Kiosk', papel: 'operador', via: 'anon' };
    }
    throw error;
  }
}

function generateTxid() {
  return (`NOX${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);
}

export async function registerPalm(req, env, ctx) {
  const user = await hotelGuard(req, env, { manager: false });
  const body = await readJson(req, 4 * 1024 * 1024);
  const nome = str(body.nome, 160);
  const cpf = onlyDigits(body.cpf || body.doc) || null;
  const tel = onlyDigits(body.tel || body.telefone) || null;
  const quarto = str(body.quarto, 30) || null;
  const template = str(body.vein_template_b64 || body.template, 2_000_000);
  const deviceId = str(body.device_id, 120) || null;
  if (!nome) throw new HttpError(400, 'Nome é obrigatório', 'VALIDATION');
  if (!template || template.length < 16) {
    throw new HttpError(400, 'Template biométrico inválido', 'VALIDATION');
  }
  const db = dbRequired(env);
  const templateHash = await sha256Hex(template);

  const duplicate = await db
    .prepare(
      `SELECT pt.hospede_id, p.nome FROM palm_templates pt
       JOIN pessoas p ON p.id = pt.hospede_id WHERE pt.template_hash = ?`
    )
    .bind(templateHash)
    .first();

  let hospede = cpf
    ? await db.prepare('SELECT id, nome FROM pessoas WHERE doc = ? LIMIT 1').bind(cpf).first()
    : tel
      ? await db.prepare('SELECT id, nome FROM pessoas WHERE tel = ? LIMIT 1').bind(tel).first()
      : null;

  if (duplicate && (!hospede || duplicate.hospede_id !== hospede.id)) {
    throw new HttpError(409, `Biometria já cadastrada para ${duplicate.nome}`, 'PALM_ALREADY_REGISTERED');
  }

  if (hospede) {
    await db
      .prepare('UPDATE pessoas SET nome = ?, doc = COALESCE(?, doc), tel = COALESCE(?, tel) WHERE id = ?')
      .bind(nome, cpf, tel, hospede.id)
      .run();
  } else {
    const result = await db
      .prepare("INSERT INTO pessoas (nome, doc, tipo, tel) VALUES (?, ?, 'PF', ?)")
      .bind(nome, cpf, tel)
      .run();
    hospede = { id: result.meta?.last_row_id, nome };
  }

  const storedTemplate = await encryptSensitive(template, env);
  await db.batch([
    db.prepare('DELETE FROM palm_templates WHERE hospede_id = ?').bind(hospede.id),
    db
      .prepare(
        `INSERT INTO palm_templates (hospede_id, template_hash, template_b64, device_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(hospede.id, templateHash, storedTemplate, deviceId),
  ]);

  if (quarto) {
    await db.batch([
      db
        .prepare(
          `UPDATE hospede_quarto SET status = 'checkout', checkout = datetime('now')
           WHERE quarto = ? AND status = 'ocupado'`
        )
        .bind(quarto),
      db
        .prepare("INSERT INTO hospede_quarto (hospede_id, quarto, status) VALUES (?, ?, 'ocupado')")
        .bind(hospede.id, quarto),
    ]);
  }

  audit(env, ctx, {
    usuario: user.email,
    acao: 'palm_cadastro',
    entidade: 'pessoas',
    entidade_id: String(hospede.id),
    detalhe: { quarto, deviceId },
  });
  return {
    ok: true,
    hospede_id: hospede.id,
    nome,
    quarto,
    msg: 'Hóspede e biometria cadastrados com sucesso',
  };
}

export async function identifyAndCharge(req, env, ctx) {
  const user = await hotelGuard(req, env);
  const body = await readJson(req);
  const template = str(body.vein_template_b64 || body.template, 2_000_000);
  if (!template) throw new HttpError(400, 'Template biométrico obrigatório', 'VALIDATION');
  const db = dbRequired(env);
  const templateHash = await sha256Hex(template);

  const palm = await db
    .prepare(
      `SELECT pt.hospede_id, p.nome, p.doc, p.tel
       FROM palm_templates pt
       JOIN pessoas p ON p.id = pt.hospede_id
       WHERE pt.template_hash = ?`
    )
    .bind(templateHash)
    .first();
  if (!palm) {
    throw new HttpError(404, 'Biometria não cadastrada', 'PALM_NOT_FOUND');
  }

  let quarto = str(body.quarto, 30);
  if (!quarto) {
    const occupancy = await db
      .prepare(
        `SELECT quarto FROM hospede_quarto
         WHERE hospede_id = ? AND status = 'ocupado' ORDER BY id DESC LIMIT 1`
      )
      .bind(palm.hospede_id)
      .first();
    quarto = occupancy?.quarto || 'SEM_QUARTO';
  }

  const requested = Array.isArray(body.itens) ? body.itens.slice(0, 40) : [];
  const items = [];
  const stockUpdates = [];
  let total = 0;
  for (const raw of requested) {
    const sku = str(raw.sku, 60);
    if (!sku) continue;
    const product = await db
      .prepare('SELECT id, nome, preco, estoque FROM frigobar_itens WHERE sku = ? AND ativo = 1')
      .bind(sku)
      .first();
    if (!product) continue;
    const quantity = Math.max(1, Math.min(99, Math.trunc(num(raw.quantidade ?? raw.qtd, 1, 1, 99))));
    if (Number(product.estoque) < quantity) {
      throw new HttpError(
        409,
        `Estoque insuficiente: ${product.nome} (disponível ${product.estoque})`,
        'STOCK_OUT',
        { sku, estoque: product.estoque, solicitado: quantity }
      );
    }
    total += Number(product.preco) * quantity;
    items.push({ itemId: product.id, sku, nome: product.nome, qtd: quantity, preco: money(product.preco) });
    stockUpdates.push(
      db
        .prepare('UPDATE frigobar_itens SET estoque = MAX(0, estoque - ?) WHERE id = ?')
        .bind(quantity, product.id)
    );
  }
  total = money(total || num(body.valor, 25, 0, 1e7));
  if (total <= 0) {
    throw new HttpError(400, 'Valor do consumo inválido', 'VALIDATION');
  }

  const descricaoBase = str(body.descricao, 300) || 'Consumo Frigobar';
  const descricao = items.length
    ? `${descricaoBase} | ${items.map((item) => `${item.nome}x${item.qtd}`).join(', ')}`
    : descricaoBase;
  const txid = generateTxid();
  const deviceId = str(body.device_id, 120) || null;

  const statements = [
    db
      .prepare(
        `INSERT INTO consumos_hotel
           (quarto, hospede_id, descricao, valor, pago_via, txid_pix, status, device_id)
         VALUES (?, ?, ?, ?, 'palma', ?, 'pendente', ?)`
      )
      .bind(quarto, palm.hospede_id, descricao, total, txid, deviceId),
    ...stockUpdates,
  ];
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    console.error('Consumo hotel falhou:', error?.message || error);
    throw new HttpError(500, 'Não foi possível registrar o consumo', 'CONSUMPTION_FAILED');
  }
  const consumoId = results?.[0]?.meta?.last_row_id || null;

  let pix = null;
  if (interConfigured(env)) {
    try {
      pix = await createInterPix(
        env,
        {
          valor: total,
          descricao: `${descricaoBase} - Quarto ${quarto}`,
          clienteNome: palm.nome,
          clienteDoc: palm.doc,
          txid,
        },
        user
      );
    } catch (error) {
      console.error('PIX Inter no consumo falhou:', error?.message || error);
    }
  }
  const status = pix ? 'ativo' : 'pago_local';
  await db
    .prepare('UPDATE consumos_hotel SET status = ? WHERE id = ?')
    .bind(status, consumoId)
    .run()
    .catch(() => {});

  if (items.length && consumoId) {
    await db
      .batch(
        items.map((item) =>
          db
            .prepare(
              `INSERT INTO frigobar_movimentacao (item_id, quarto, quantidade, tipo, consumo_id)
               VALUES (?, ?, ?, 'consumo', ?)`
            )
            .bind(item.itemId, quarto, -item.qtd, consumoId)
        )
      )
      .catch((error) => console.error('Movimentação frigobar falhou:', error?.message || error));
  }

  audit(env, ctx, {
    usuario: user.email,
    acao: 'palm_consumo',
    entidade: 'consumos_hotel',
    entidade_id: String(consumoId),
    detalhe: { quarto, total, itens: items.length, txid },
  });
  return {
    ok: true,
    consumoId,
    hospede: { id: palm.hospede_id, nome: palm.nome, cpf: palm.doc },
    quarto,
    valor: total,
    txid,
    status,
    detalhes: items.map(({ sku, nome, qtd, preco }) => ({ sku, nome, qtd, preco })),
    pixCopiaECola: pix?.pixCopiaECola || null,
    inter_status: pix?.status || null,
    msg: 'Pagamento autorizado via Palma da Mão',
  };
}

export async function listConsumos(req, env, url) {
  await hotelGuard(req, env);
  const db = dbRequired(env);
  const quarto = str(url.searchParams.get('quarto'), 30);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const query = quarto
    ? `SELECT c.*, p.nome FROM consumos_hotel c
       LEFT JOIN pessoas p ON p.id = c.hospede_id
       WHERE c.quarto = ? ORDER BY c.id DESC LIMIT ?`
    : `SELECT c.*, p.nome FROM consumos_hotel c
       LEFT JOIN pessoas p ON p.id = c.hospede_id
       ORDER BY c.id DESC LIMIT ?`;
  const statement = db.prepare(query);
  const { results } = quarto
    ? await statement.bind(quarto, limit).all()
    : await statement.bind(limit).all();
  return { ok: true, consumos: results || [] };
}

export async function listGuests(req, env) {
  await hotelGuard(req, env);
  const { results } = await dbRequired(env)
    .prepare(
      `SELECT hq.id, hq.quarto, hq.checkin, hq.status, p.id AS hospede_id, p.nome, p.doc, p.tel
       FROM hospede_quarto hq
       JOIN pessoas p ON p.id = hq.hospede_id
       WHERE hq.status = 'ocupado'
       ORDER BY hq.quarto`
    )
    .all();
  return { ok: true, hospedes: results || [] };
}

export async function listFrigobar(req, env) {
  await hotelGuard(req, env);
  const { results } = await dbRequired(env)
    .prepare('SELECT * FROM frigobar_itens WHERE ativo = 1 ORDER BY nome')
    .all();
  return { ok: true, itens: results || [] };
}

export async function replenishFrigobar(req, env, ctx) {
  const user = await hotelGuard(req, env, { manager: true });
  const body = await readJson(req);
  const sku = str(body.sku, 60);
  const quantity = Math.trunc(num(body.quantidade, 0, 0, 100000));
  if (!sku || quantity <= 0) {
    throw new HttpError(400, 'SKU e quantidade válidos são obrigatórios', 'VALIDATION');
  }
  const db = dbRequired(env);
  const item = await db.prepare('SELECT id, nome FROM frigobar_itens WHERE sku = ?').bind(sku).first();
  if (!item) throw new HttpError(404, 'Item do frigobar não encontrado', 'NOT_FOUND');
  await db.batch([
    db.prepare('UPDATE frigobar_itens SET estoque = estoque + ? WHERE id = ?').bind(quantity, item.id),
    db
      .prepare(
        `INSERT INTO frigobar_movimentacao (item_id, quantidade, tipo) VALUES (?, ?, 'reposicao')`
      )
      .bind(item.id, quantity),
  ]);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'frigobar_reposicao',
    entidade: 'frigobar_itens',
    entidade_id: sku,
    detalhe: { quantity },
  });
  return { ok: true, sku, quantidade: quantity };
}

export async function upsertFrigobarItem(req, env, ctx) {
  const user = await hotelGuard(req, env, { manager: true });
  const body = await readJson(req);
  const sku = str(body.sku, 60);
  const nome = str(body.nome, 160);
  if (!sku || !nome) throw new HttpError(400, 'SKU e nome são obrigatórios', 'VALIDATION');
  const preco = money(body.preco);
  const estoque = Math.trunc(num(body.estoque, 0, 0, 1e7));
  const minimo = Math.trunc(num(body.estoque_minimo, 3, 0, 1e6));
  await dbRequired(env)
    .prepare(
      `INSERT INTO frigobar_itens (sku, nome, preco, estoque, estoque_minimo, ativo)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(sku) DO UPDATE SET
         nome = excluded.nome, preco = excluded.preco, estoque = excluded.estoque,
         estoque_minimo = excluded.estoque_minimo, ativo = 1`
    )
    .bind(sku, nome, preco, estoque, minimo)
    .run();
  audit(env, ctx, {
    usuario: user.email,
    acao: 'frigobar_item',
    entidade: 'frigobar_itens',
    entidade_id: sku,
  });
  const item = await env.DB.prepare('SELECT * FROM frigobar_itens WHERE sku = ?').bind(sku).first();
  return { ok: true, item };
}
