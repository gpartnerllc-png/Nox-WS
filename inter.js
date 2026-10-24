import { HttpError, money, num, onlyDigits, str } from '../lib/http.js';
import { bytesToB64 } from '../lib/security.js';
import { savePayment, updatePaymentStatus } from '../lib/payments.js';

const INTER_BASE = 'https://cdpj.partners.bancointer.com.br';
let cachedToken = null;
let cachedTokenExpires = 0;

export function interConfigured(env) {
  return Boolean(env.INTER_CLIENT_ID && env.INTER_CLIENT_SECRET && env.INTER_PIX_CHAVE);
}

function transport(env) {
  return env.INTER_MTLS && typeof env.INTER_MTLS.fetch === 'function' ? env.INTER_MTLS : null;
}

async function interFetchRaw(env, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.INTER_TIMEOUT_MS || 20000));
  try {
    const mtls = transport(env);
    const response = await (mtls ? mtls.fetch(url, { ...options, signal: controller.signal }) : fetch(url, { ...options, signal: controller.signal }));
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    return { response, data };
  } catch (error) {
    if (error?.name === 'AbortError') throw new HttpError(504, 'Banco Inter não respondeu a tempo', 'INTER_TIMEOUT');
    throw new HttpError(502, `Falha ao conectar no Banco Inter: ${error?.message || error}`, 'INTER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(env) {
  if (!env.INTER_CLIENT_ID || !env.INTER_CLIENT_SECRET) {
    throw new HttpError(503, 'INTER_CLIENT_ID / INTER_CLIENT_SECRET não configurados', 'INTER_NOT_CONFIGURED');
  }
  if (cachedToken && cachedTokenExpires > Date.now() + 30000) return cachedToken;
  const basic = btoa(`${env.INTER_CLIENT_ID}:${env.INTER_CLIENT_SECRET}`);
  const { response, data } = await interFetchRaw(env, `${INTER_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(
      env.INTER_SCOPES || 'cob.write cob.read pix.read'
    )}`,
  });
  if (!response.ok || !data.access_token) {
    throw new HttpError(502, `Token Inter falhou: ${data.error_description || data.error || response.status}`, 'INTER_AUTH_ERROR');
  }
  cachedToken = data.access_token;
  cachedTokenExpires = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function interFetch(env, path, options = {}, retry = true) {
  if (!interConfigured(env)) {
    throw new HttpError(503, 'Banco Inter não configurado (client id, secret e chave PIX)', 'INTER_NOT_CONFIGURED');
  }
  const token = await getToken(env);
  const { response, data } = await interFetchRaw(env, `${INTER_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'NoxMob/2.0',
      ...(options.headers || {}),
    },
  });
  if (response.status === 401 && retry) {
    cachedToken = null;
    return interFetch(env, path, options, false);
  }
  if (!response.ok) {
    const detail = data?.detail || data?.title || data?.message || `HTTP ${response.status}`;
    throw new HttpError(response.status === 401 ? 502 : response.status, `Banco Inter: ${detail}`, 'INTER_ERROR', {
      provider: data,
    });
  }
  return data;
}

function generateTxid() {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return (`NOX${Date.now().toString(36)}${bytesToB64(random).replace(/[^a-zA-Z0-9]/g, '')}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 35);
}

function mapStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'CONCLUIDA' || status === 'CONCLUÍDA') return 'pago';
  if (status === 'EXPIRADA') return 'expirado';
  if (status.startsWith('REMOVIDA')) return 'cancelado';
  return 'pendente';
}

export async function createInterPix(env, input = {}, user = null) {
  if (!interConfigured(env)) {
    throw new HttpError(503, 'Banco Inter não configurado (client id, secret e chave PIX)', 'INTER_NOT_CONFIGURED');
  }
  const valor = money(input.valor ?? input.value);
  if (valor <= 0) throw new HttpError(400, 'Valor inválido', 'VALIDATION');
  const txid = str(input.txid, 35).replace(/[^a-zA-Z0-9]/g, '') || generateTxid();
  const descricao = str(input.descricao || input.description || input.solicitacao, 140) || 'Cobrança NoxMob';
  const nome = str(input.clienteNome, 140) || 'Cliente NoxMob';
  const cpf = onlyDigits(input.clienteDoc || input.cpf);
  const payload = {
    calendario: { expiracao: Math.min(86400, Math.max(60, num(input.expiracao, 3600, 60, 86400))) },
    valor: { original: valor.toFixed(2) },
    chave: env.INTER_PIX_CHAVE,
    solicitacaoPagador: descricao,
  };
  if (cpf.length === 11 || cpf.length === 14) {
    payload.devedor = { cpf: cpf.length === 11 ? cpf : undefined, cnpj: cpf.length === 14 ? cpf : undefined, nome };
  }

  const charge = await interFetch(env, `/pix/v2/cob/${encodeURIComponent(txid)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  let qr = null;
  const locationId = charge.loc?.id;
  if (locationId) {
    try {
      qr = await interFetch(env, `/pix/v2/loc/${encodeURIComponent(locationId)}/qrcode`);
    } catch (error) {
      console.error('QR Inter falhou:', error?.message || error);
    }
  }

  const payment = {
    provider: 'inter',
    metodo: 'pix',
    status: mapStatus(charge.status),
    statusProvider: charge.status || null,
    valor,
    descricao,
    clienteNome: nome,
    clienteDoc: cpf || null,
    externalId: txid,
    txid,
    qrPayload: charge.pixCopiaECola || qr?.qrcode || null,
    qrImage: qr?.imagemQrcode || null,
    expiraEm: charge.calendario?.criacao
      ? new Date(Date.parse(charge.calendario.criacao) + (charge.calendario.expiracao || 3600) * 1000).toISOString()
      : null,
    vendaId: input.vendaId || null,
    criadoPor: user?.email || null,
    payload: charge,
  };
  payment.localId = await savePayment(env, payment);
  return {
    ...payment,
    pixCopiaECola: payment.qrPayload,
    locationId: locationId || null,
  };
}

export async function getInterStatus(env, txidRaw) {
  if (!interConfigured(env)) {
    throw new HttpError(503, 'Banco Inter não configurado', 'INTER_NOT_CONFIGURED');
  }
  const txid = str(txidRaw, 35).replace(/[^a-zA-Z0-9]/g, '');
  if (!txid) throw new HttpError(400, 'txid obrigatório', 'VALIDATION');
  const charge = await interFetch(env, `/pix/v2/cob/${encodeURIComponent(txid)}`);
  const status = mapStatus(charge.status);
  await updatePaymentStatus(env, {
    provider: 'inter',
    externalId: txid,
    txid,
    status,
    pagoEm: status === 'pago' ? new Date().toISOString() : null,
    payload: charge,
  });
  return {
    ok: true,
    status,
    statusProvider: charge.status,
    txid,
    valor: money(charge.valor?.original),
    pixCopiaECola: charge.pixCopiaECola || null,
    raw: charge,
  };
}

export async function getInterPixForPalm(env, { valor, nome, cpf, solicitacao }) {
  if (!interConfigured(env)) return null;
  try {
    const result = await createInterPix(env, {
      valor,
      descricao: solicitacao,
      clienteNome: nome,
      clienteDoc: cpf,
    });
    return result;
  } catch (error) {
    console.error('Inter palm falhou:', error?.message || error);
    return null;
  }
}
