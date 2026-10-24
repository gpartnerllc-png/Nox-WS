import { HttpError, money, num, readJson, str } from './lib/http.js';
import { audit, enforceRateLimit, requireAuth } from './lib/auth.js';
import { findPayment, listPayments, updatePaymentStatus } from './lib/payments.js';
import {
  asaasConfigured,
  createAsaasCheckout,
  createAsaasPix,
  getAsaasStatus,
  handleAsaasWebhook,
} from './providers/asaas.js';
import {
  createInterPix,
  getInterStatus,
  interConfigured,
} from './providers/inter.js';
import { createUpiCharge, upiConfigured } from './providers/upi.js';
import { applePayStatus, startApplePaySession } from './providers/applepay.js';

function dbRequired(env) {
  if (!env.DB) throw new HttpError(503, 'D1 não conectado', 'DB_REQUIRED');
  return env.DB;
}

async function withSaleData(env, input) {
  const saleId = Math.trunc(num(input.vendaId ?? input.venda_id, 0, 0));
  if (!saleId) return input;
  const sale = await dbRequired(env)
    .prepare('SELECT id, total, cliente_nome, cliente_tel, numero FROM vendas WHERE id = ?')
    .bind(saleId)
    .first();
  if (!sale) throw new HttpError(404, 'Venda não encontrada', 'SALE_NOT_FOUND');
  return {
    ...input,
    vendaId: sale.id,
    valor: input.valor ?? input.value ?? sale.total,
    descricao:
      input.descricao || input.description || `Venda ${sale.numero || `#${sale.id}`} · NoxMob`,
    clienteNome: input.clienteNome || sale.cliente_nome || '',
    clienteTelefone: input.clienteTelefone || sale.cliente_tel || '',
  };
}

function paymentRateKey(user) {
  return `payment:${user?.email || 'anon'}`;
}

export async function handleAsaasPixCreate(req, env, ctx) {
  const user = await requireAuth(req, env);
  await enforceRateLimit(env, paymentRateKey(user), 60, 3600);
  const input = await withSaleData(env, await readJson(req));
  const result = await createAsaasPix(env, input, user);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'pagamento_asaas_pix',
    entidade: 'pagamentos',
    entidade_id: String(result.localId || ''),
    detalhe: { valor: result.valor, externalId: result.externalId },
  });
  return { ok: true, ...result };
}

export async function handleAsaasCheckoutCreate(req, env, ctx) {
  const user = await requireAuth(req, env);
  await enforceRateLimit(env, paymentRateKey(user), 60, 3600);
  const input = await withSaleData(env, await readJson(req));
  const result = await createAsaasCheckout(env, input, user);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'pagamento_asaas_checkout',
    entidade: 'pagamentos',
    entidade_id: String(result.localId || ''),
    detalhe: { valor: result.valor },
  });
  return { ok: true, ...result };
}

export async function handleAsaasStatus(req, env, id) {
  await requireAuth(req, env);
  const result = await getAsaasStatus(env, id);
  return { ok: true, ...result };
}

export async function handleAsaasWebhookRoute(req, env) {
  const result = await handleAsaasWebhook(req, env);
  return result;
}

export async function handleInterPixCreate(req, env, ctx) {
  const user = await requireAuth(req, env);
  await enforceRateLimit(env, paymentRateKey(user), 60, 3600);
  const input = await withSaleData(env, await readJson(req));
  const result = await createInterPix(env, input, user);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'pagamento_inter_pix',
    entidade: 'pagamentos',
    entidade_id: String(result.localId || ''),
    detalhe: { valor: result.valor, txid: result.txid },
  });
  return { ok: true, ...result };
}

export async function handleInterStatus(req, env, txid) {
  await requireAuth(req, env);
  return getInterStatus(env, txid);
}

export async function handleUpiCreate(req, env, ctx) {
  const user = await requireAuth(req, env);
  await enforceRateLimit(env, paymentRateKey(user), 60, 3600);
  const input = await withSaleData(env, await readJson(req));
  const result = await createUpiCharge(env, input, user);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'pagamento_upi',
    entidade: 'pagamentos',
    entidade_id: String(result.localId || ''),
    detalhe: { valor: result.valor, txid: result.txid },
  });
  return { ok: true, ...result };
}

export async function handleUpiConfirm(req, env, ctx) {
  const user = await requireAuth(req, env, ['admin', 'gerente']);
  const body = await readJson(req);
  const txid = str(body.txid || body.externalId, 80);
  const status = str(body.status, 20) || 'pago';
  if (!['pago', 'cancelado', 'expirado'].includes(status)) {
    throw new HttpError(400, 'Status inválido', 'VALIDATION');
  }
  const payment = await findPayment(env, { provider: 'upi', externalId: txid });
  if (!payment) throw new HttpError(404, 'Cobrança UPI não encontrada', 'NOT_FOUND');
  await updatePaymentStatus(env, {
    provider: 'upi',
    externalId: txid,
    status,
    pagoEm: status === 'pago' ? new Date().toISOString() : null,
    payload: { ...(payment.payload_json ? JSON.parse(payment.payload_json) : {}), confirmadoPor: user.email },
  });
  audit(env, ctx, {
    usuario: user.email,
    acao: 'pagamento_upi_confirmado',
    entidade: 'pagamentos',
    entidade_id: String(payment.id),
    detalhe: { txid, status },
  });
  return { ok: true, txid, status };
}

export async function handleApplePayStatus(req, env) {
  await requireAuth(req, env);
  return { ok: true, ...applePayStatus(env) };
}

export async function handleApplePaySession(req, env, ctx) {
  const user = await requireAuth(req, env);
  const body = await readJson(req);
  const result = await startApplePaySession(env, body);
  audit(env, ctx, {
    usuario: user.email,
    acao: 'applepay_sessao',
    entidade: 'pagamentos',
    detalhe: { displayName: body.displayName || 'NoxMob' },
  });
  return result;
}

export async function handlePaymentsList(req, env, url) {
  await requireAuth(req, env);
  const payments = await listPayments(env, {
    limit: url.searchParams.get('limit'),
    provider: str(url.searchParams.get('provider'), 30),
    status: str(url.searchParams.get('status'), 30),
  });
  return { ok: true, pagamentos: payments };
}

export async function handlePaymentDetail(req, env, idRaw) {
  await requireAuth(req, env);
  const id = Math.trunc(num(idRaw, 0, 0));
  if (!id) throw new HttpError(400, 'ID inválido', 'VALIDATION');
  const payment = await dbRequired(env)
    .prepare('SELECT * FROM pagamentos WHERE id = ?')
    .bind(id)
    .first();
  if (!payment) throw new HttpError(404, 'Pagamento não encontrado', 'NOT_FOUND');
  let payload = null;
  try {
    payload = payment.payload_json ? JSON.parse(payment.payload_json) : null;
  } catch {
    payload = null;
  }
  return { ok: true, pagamento: { ...payment, payload } };
}

export async function handleProvidersStatus(req, env) {
  await requireAuth(req, env);
  return {
    ok: true,
    provedores: {
      asaas: {
        configurado: asaasConfigured(env),
        ambiente: String(env.ASAAS_BASE || '').includes('sandbox') ? 'sandbox' : 'produção',
        metodos: ['pix', 'checkout'],
      },
      inter: {
        configurado: interConfigured(env),
        mTLS: Boolean(env.INTER_MTLS),
        metodos: ['pix'],
      },
      upi: {
        configurado: upiConfigured(env),
        moeda: 'INR',
        metodos: ['upi', 'google_pay_intent'],
      },
      applepay: applePayStatus(env),
      regra: 'O NoxMob nunca armazena números de cartão, CVV ou dados de tarja. Checkout de cartão acontece no ambiente do provedor.',
    },
  };
}

export function paymentSummary(value) {
  return money(value);
}
