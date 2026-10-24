import { HttpError, money, num, onlyDigits, str, todayISO } from '../lib/http.js';
import { timingSafeEqual } from '../lib/security.js';
import { findPayment, savePayment, updatePaymentStatus } from '../lib/payments.js';

export function asaasConfigured(env) {
  return Boolean(env.ASAAS_API_KEY);
}

export function asaasBase(env) {
  const raw = String(env.ASAAS_BASE || 'https://api-sandbox.asaas.com').replace(/\/+$/, '');
  return /\/v3$/i.test(raw) ? raw : `${raw}/v3`;
}

async function asaasFetch(env, path, options = {}) {
  if (!env.ASAAS_API_KEY) {
    throw new HttpError(503, 'ASAAS_API_KEY não configurada no Worker', 'ASAAS_NOT_CONFIGURED');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.ASAAS_TIMEOUT_MS || 20000));
  try {
    const response = await fetch(asaasBase(env) + path, {
      ...options,
      signal: controller.signal,
      headers: {
        access_token: env.ASAAS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'NoxMob/2.0',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    if (!response.ok) {
      const description =
        data?.errors?.map((error) => error.description).filter(Boolean).join(' · ') ||
        data?.message ||
        `HTTP ${response.status}`;
      throw new HttpError(response.status === 401 ? 502 : response.status, `Asaas: ${description}`, 'ASAAS_ERROR', {
        provider: data,
      });
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'AbortError') throw new HttpError(504, 'Asaas não respondeu a tempo', 'ASAAS_TIMEOUT');
    throw new HttpError(502, `Falha ao conectar no Asaas: ${error?.message || error}`, 'ASAAS_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCustomer(env, cliente = {}) {
  const nome = str(cliente.nome, 160);
  const cpfCnpj = onlyDigits(cliente.cpfCnpj || cliente.doc);
  const email = str(cliente.email, 180);
  const phone = onlyDigits(cliente.telefone || cliente.phone);
  if (!nome && !cpfCnpj) return null;
  if (cpfCnpj) {
    const found = await asaasFetch(
      env,
      `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`
    );
    const existing = found?.data?.[0];
    if (existing?.id) return existing.id;
  }
  const created = await asaasFetch(env, '/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: nome || 'Cliente NoxMob',
      cpfCnpj: cpfCnpj || undefined,
      email: email || undefined,
      mobilePhone: phone || undefined,
      externalReference: str(cliente.externalReference, 100) || 'noxmob',
    }),
  });
  if (!created?.id) throw new HttpError(502, 'Asaas não retornou o cliente criado', 'ASAAS_CUSTOMER_ERROR');
  return created.id;
}

function mapStatus(status) {
  const value = String(status || '').toUpperCase();
  if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(value)) return 'pago';
  if (['OVERDUE'].includes(value)) return 'expirado';
  if (['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS'].includes(value)) return 'estornado';
  if (['CANCELED', 'DELETED'].includes(value)) return 'cancelado';
  return 'pendente';
}

function normalizePayment(env, data, extra = {}) {
  const id = data.id || extra.externalId || null;
  return {
    provider: 'asaas',
    metodo: extra.metodo || 'pix',
    status: mapStatus(data.status),
    statusProvider: data.status || null,
    valor: money(data.value || extra.valor || 0),
    descricao: data.description || extra.descricao || 'NoxMob',
    externalId: id,
    qrPayload: extra.qrPayload || data.pixCopiaECola || null,
    qrImage: extra.qrImage || null,
    checkoutUrl: data.invoiceUrl || data.bankSlipUrl || null,
    expiraEm: extra.expiraEm || data.dueDate || null,
    clienteNome: extra.clienteNome || null,
    clienteDoc: extra.clienteDoc || null,
    vendaId: extra.vendaId || null,
    criadoPor: extra.criadoPor || null,
    payload: data,
  };
}

export async function createAsaasPix(env, input = {}, user = null) {
  const valor = money(input.valor ?? input.value);
  if (valor <= 0) throw new HttpError(400, 'Valor inválido', 'VALIDATION');
  const descricao = str(input.descricao || input.description, 500) || 'NoxMob';
  const clienteNome = str(input.clienteNome || input.cliente?.nome, 180);
  const clienteDoc = onlyDigits(input.clienteDoc || input.cliente?.cpfCnpj || input.cpfCnpj);
  const clienteEmail = str(input.clienteEmail || input.cliente?.email, 180);
  const clienteTel = str(input.clienteTelefone || input.cliente?.telefone, 30);
  const customerId = await ensureCustomer(env, {
    nome: clienteNome,
    cpfCnpj: clienteDoc,
    email: clienteEmail,
    telefone: clienteTel,
    externalReference: input.clientRequestId,
  });
  const externalReference = str(input.clientRequestId, 100) || `nox-${Date.now()}`;
  const payment = await asaasFetch(env, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId || undefined,
      billingType: 'PIX',
      value: valor,
      dueDate: todayISO(),
      description: descricao,
      externalReference,
      postalService: false,
    }),
  });
  let qr = null;
  try {
    qr = await asaasFetch(env, `/payments/${encodeURIComponent(payment.id)}/pixQrCode`);
  } catch (error) {
    console.error('QR PIX Asaas falhou:', error?.message || error);
  }
  const normalized = normalizePayment(env, payment, {
    metodo: 'pix',
    descricao,
    clienteNome,
    clienteDoc,
    valor,
    vendaId: input.vendaId,
    criadoPor: user?.email,
    qrPayload: qr?.payload,
    qrImage: qr?.encodedImage,
    expiraEm: qr?.expirationDate,
  });
  normalized.localId = await savePayment(env, normalized);
  return {
    ...normalized,
    customerId,
    invoiceUrl: payment.invoiceUrl || null,
    status: normalized.status,
    qr: qr
      ? {
          payload: qr.payload,
          encodedImage: qr.encodedImage,
          expirationDate: qr.expirationDate,
        }
      : null,
  };
}

export async function createAsaasCheckout(env, input = {}, user = null) {
  const valor = money(input.valor ?? input.value);
  if (valor <= 0) throw new HttpError(400, 'Valor inválido', 'VALIDATION');
  const descricao = str(input.descricao || input.description, 500) || 'NoxMob';
  const clienteNome = str(input.clienteNome || input.cliente?.nome, 180);
  const clienteDoc = onlyDigits(input.clienteDoc || input.cliente?.cpfCnpj || input.cpfCnpj);
  const customerId = await ensureCustomer(env, {
    nome: clienteNome,
    cpfCnpj: clienteDoc,
    email: str(input.clienteEmail || input.cliente?.email, 180),
    telefone: str(input.clienteTelefone || input.cliente?.telefone, 30),
    externalReference: input.clientRequestId,
  });
  const payment = await asaasFetch(env, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId || undefined,
      billingType: 'UNDEFINED',
      value: valor,
      dueDate: new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10),
      description: descricao,
      externalReference: str(input.clientRequestId, 100) || `nox-checkout-${Date.now()}`,
      postalService: false,
    }),
  });
  const normalized = normalizePayment(env, payment, {
    metodo: 'checkout',
    descricao,
    clienteNome,
    clienteDoc,
    valor,
    vendaId: input.vendaId,
    criadoPor: user?.email,
  });
  normalized.localId = await savePayment(env, normalized);
  return {
    ...normalized,
    invoiceUrl: payment.invoiceUrl || null,
    aviso: 'O cliente escolhe PIX ou cartão no ambiente seguro do Asaas. O NoxMob não recebe dados do cartão.',
  };
}

export async function getAsaasStatus(env, id) {
  const externalId = str(id, 180);
  if (!externalId) throw new HttpError(400, 'ID do pagamento obrigatório', 'VALIDATION');
  const payment = await asaasFetch(env, `/payments/${encodeURIComponent(externalId)}`);
  const status = mapStatus(payment.status);
  await updatePaymentStatus(env, {
    provider: 'asaas',
    externalId,
    status,
    pagoEm: status === 'pago' ? new Date().toISOString() : null,
    payload: payment,
  });
  return {
    ok: true,
    status,
    statusProvider: payment.status,
    externalId,
    valor: money(payment.value),
    invoiceUrl: payment.invoiceUrl || null,
    pagoEm: payment.paymentDate || payment.confirmedDate || null,
    raw: payment,
  };
}

export async function syncAsaasPayment(env, externalId) {
  try {
    return await getAsaasStatus(env, externalId);
  } catch (error) {
    console.error('Sync Asaas falhou:', error?.message || error);
    return null;
  }
}

export async function handleAsaasWebhook(req, env) {
  const token = req.headers.get('asaas-access-token') || req.headers.get('Asaas-Access-Token') || '';
  if (!env.ASAAS_WEBHOOK_TOKEN || !timingSafeEqual(token, env.ASAAS_WEBHOOK_TOKEN)) {
    throw new HttpError(401, 'Webhook Asaas não autorizado', 'WEBHOOK_UNAUTHORIZED');
  }
  const payload = await req.json();
  const payment = payload.payment || payload;
  const externalId = str(payment.id, 180);
  const statusProvider = str(payment.status, 40).toUpperCase();
  const status = mapStatus(statusProvider);
  const pagoEm = status === 'pago' ? new Date().toISOString() : null;
  if (externalId) {
    await updatePaymentStatus(env, {
      provider: 'asaas',
      externalId,
      status,
      pagoEm,
      payload,
    });
  }
  return {
    ok: true,
    event: str(payload.event, 80),
    externalId,
    status,
    statusProvider,
  };
}

export { findPayment };
