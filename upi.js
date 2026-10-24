import { HttpError, money, onlyDigits, str } from '../lib/http.js';
import { bytesToB64Url, validUpiVpa } from '../lib/security.js';
import { savePayment } from '../lib/payments.js';

export function upiConfigured(env) {
  return Boolean(env.UPI_VPA && validUpiVpa(env.UPI_VPA));
}

export function buildUpiUri(env, { valor, note, txid, merchantName, merchantCode } = {}) {
  const amount = money(valor);
  if (amount <= 0) throw new HttpError(400, 'Valor inválido para UPI', 'VALIDATION');
  if (!upiConfigured(env)) {
    throw new HttpError(503, 'Configure UPI_VPA para habilitar Google Pay / UPI (Índia)', 'UPI_NOT_CONFIGURED');
  }
  const transactionRef =
    str(txid, 35).replace(/[^a-zA-Z0-9]/g, '') ||
    `NOX${Date.now().toString(36)}${bytesToB64Url(crypto.getRandomValues(new Uint8Array(5))).slice(0, 5)}`;
  const params = [
    ['pa', env.UPI_VPA],
    ['pn', str(merchantName || env.UPI_MERCHANT_NAME, 120) || 'NoxMob'],
    ['mc', str(merchantCode || env.UPI_MERCHANT_CODE, 10) || '5411'],
    ['tr', transactionRef],
    ['tn', str(note, 100) || 'Compra NoxMob'],
    ['am', amount.toFixed(2)],
    ['cu', 'INR'],
  ];
  if (env.UPI_TX_URL) params.push(['url', env.UPI_TX_URL]);
  const query = params
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return {
    uri: `upi://pay?${query}`,
    gpayIntent: `intent://pay?${query}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`,
    txid: transactionRef,
    valor: amount,
  };
}

export async function createUpiCharge(env, input = {}, user = null) {
  const charge = buildUpiUri(env, {
    valor: input.valor ?? input.value,
    note: input.descricao || input.note,
    txid: input.txid,
    merchantName: input.merchantName,
    merchantCode: input.merchantCode,
  });
  const payment = {
    provider: 'upi',
    metodo: 'upi',
    status: 'pendente',
    valor: charge.valor,
    descricao: str(input.descricao || input.note, 500) || 'Compra NoxMob',
    clienteNome: str(input.clienteNome, 180) || null,
    clienteDoc: onlyDigits(input.clienteDoc) || null,
    externalId: charge.txid,
    txid: charge.txid,
    qrPayload: charge.uri,
    vendaId: input.vendaId || null,
    criadoPor: user?.email || null,
    payload: { uri: charge.uri, gpayIntent: charge.gpayIntent, moeda: 'INR' },
  };
  payment.localId = await savePayment(env, payment);
  return {
    ...payment,
    uri: charge.uri,
    gpayIntent: charge.gpayIntent,
    moeda: 'INR',
    aviso:
      'UPI é uma rede indiana. O pagamento é confirmado manualmente ou por um PSP compatível; nenhum dado de cartão passa pelo NoxMob.',
  };
}
