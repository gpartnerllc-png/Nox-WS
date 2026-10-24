import { HttpError, num, str } from '../lib/http.js';

export async function savePayment(env, payment) {
  if (!env.DB) return null;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO pagamentos
        (provider, metodo, status, valor, descricao, cliente_nome, cliente_doc,
         external_id, txid, checkout_url, qr_payload, qr_image, expira_em,
         venda_id, criado_por, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        str(payment.provider, 30),
        str(payment.metodo, 30),
        str(payment.status, 30) || 'pendente',
        num(payment.valor, 0, 0, 1e9),
        str(payment.descricao, 500) || null,
        str(payment.clienteNome, 180) || null,
        str(payment.clienteDoc, 30) || null,
        str(payment.externalId, 180) || null,
        str(payment.txid, 80) || null,
        str(payment.checkoutUrl, 1500) || null,
        str(payment.qrPayload, 4000) || null,
        str(payment.qrImage, 300000) || null,
        str(payment.expiraEm, 60) || null,
        payment.vendaId ? num(payment.vendaId, 0) : null,
        str(payment.criadoPor, 180) || null,
        JSON.stringify(payment.payload || {}).slice(0, 20000)
      )
      .run();
    return result.meta?.last_row_id || null;
  } catch (error) {
    console.error('Falha ao salvar pagamento:', error?.message || error);
    return null;
  }
}

export async function updatePaymentStatus(env, { provider, externalId, txid, status, pagoEm, payload }) {
  if (!env.DB) return;
  const normalizedStatus = str(status, 30) || 'pendente';
  const conditions = [];
  const bindings = [normalizedStatus, pagoEm || null, JSON.stringify(payload || {}).slice(0, 20000)];
  if (externalId) {
    conditions.push('(provider = ? AND external_id = ?)');
    bindings.push(provider, externalId);
  }
  if (txid) {
    conditions.push('(provider = ? AND txid = ?)');
    bindings.push(provider, txid);
  }
  if (!conditions.length) return;
  try {
    await env.DB.prepare(
      `UPDATE pagamentos
       SET status = ?, pago_em = COALESCE(?, pago_em), payload_json = COALESCE(?, payload_json),
           atualizado_em = datetime('now')
       WHERE ${conditions.join(' OR ')}`
    )
      .bind(...bindings)
      .run();
  } catch (error) {
    console.error('Falha ao atualizar pagamento:', error?.message || error);
  }
}

export async function listPayments(env, { limit = 100, provider = '', status = '' } = {}) {
  if (!env.DB) return [];
  const clauses = [];
  const bindings = [];
  if (provider) {
    clauses.push('provider = ?');
    bindings.push(provider);
  }
  if (status) {
    clauses.push('status = ?');
    bindings.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  bindings.push(Math.min(200, Math.max(1, num(limit, 100, 1, 200))));
  const { results } = await env.DB.prepare(
    `SELECT id, provider, metodo, status, valor, descricao, cliente_nome, external_id,
            txid, checkout_url, expira_em, venda_id, criado_em, atualizado_em, pago_em
     FROM pagamentos ${where}
     ORDER BY id DESC LIMIT ?`
  )
    .bind(...bindings)
    .all();
  return results || [];
}

export async function findPayment(env, { provider, externalId, txid }) {
  if (!env.DB) return null;
  if (externalId) {
    const row = await env.DB.prepare(
      'SELECT * FROM pagamentos WHERE provider = ? AND external_id = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(provider, externalId)
      .first();
    if (row) return row;
  }
  if (txid) {
    return env.DB.prepare(
      'SELECT * FROM pagamentos WHERE provider = ? AND txid = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(provider, txid)
      .first();
  }
  return null;
}

export function providerError(provider, message, code = 'PAYMENT_ERROR') {
  return new HttpError(502, `${provider}: ${message}`, code);
}
