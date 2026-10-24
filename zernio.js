import { HttpError, num, phoneForWa, str } from '../lib/http.js';
import { hmacHex, timingSafeEqual } from '../lib/security.js';

export function zernioBase(env) {
  const configured = String(env.ZERNIO_BASE || '').trim().replace(/\/+$/, '');
  const base = /^https?:\/\//i.test(configured) ? configured : 'https://api.zernio.com';
  return base.replace(/\/api\/v1$/i, '/v1');
}

export function zernioKey(env) {
  const primary = String(env.ZERNIO_API_KEY || '').trim();
  if (primary) return primary;
  const secret = String(env.ZERNIO_SECRET_KEY || '').trim();
  if (secret) return secret;
  const fallback = String(env.ZERNIO_BASE || '').trim();
  return fallback.startsWith('sk_') ? fallback : '';
}

export function zernioConfigured(env) {
  return Boolean(zernioKey(env));
}

function buildUrl(env, path) {
  const base = zernioBase(env);
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (/\/v1$/i.test(base) && clean.startsWith('/v1/')) return base + clean.slice(3);
  return base + clean;
}

export async function zernioFetch(env, path, options = {}) {
  const key = zernioKey(env);
  if (!key) throw new HttpError(503, 'ZERNIO_API_KEY não configurada no Worker', 'ZERNIO_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.ZERNIO_TIMEOUT_MS || 20000));
  try {
    const response = await fetch(buildUrl(env, path), {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
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
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'Zernio não respondeu a tempo', 'ZERNIO_TIMEOUT');
    }
    throw new HttpError(502, `Falha ao conectar no Zernio: ${error?.message || error}`, 'ZERNIO_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

function accountFrom(env, accountId) {
  return str(accountId || env.ZERNIO_ACCOUNT_ID, 120) || '';
}

function legacySend(env, { accountId, phone, text }) {
  return zernioFetch(env, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      platform: 'whatsapp',
      accountId,
      to: phone,
      type: 'text',
      text: { body: text },
    }),
  });
}

export async function sendText(env, { accountId, profileId, conversationId, phone, text }) {
  const account = accountFrom(env, accountId);
  const message = str(text, 4096);
  if (!message) throw new HttpError(400, 'Mensagem vazia', 'VALIDATION');
  if (!conversationId && !phone) throw new HttpError(400, 'Telefone ou conversa obrigatória', 'VALIDATION');
  if (!account) throw new HttpError(503, 'ZERNIO_ACCOUNT_ID não configurado', 'ZERNIO_ACCOUNT_MISSING');

  let response;
  if (conversationId) {
    response = await zernioFetch(env, `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account, message }),
    });
  } else {
    const body = {
      accountId: account,
      participantId: phoneForWa(phone),
      message,
    };
    if (profileId || env.ZERNIO_PROFILE_ID) body.profileId = str(profileId || env.ZERNIO_PROFILE_ID, 120);
    response = await zernioFetch(env, '/v1/inbox/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  if (!response.ok && [404, 405].includes(response.status)) {
    response = await legacySend(env, { accountId: account, phone: phoneForWa(phone), text: message });
  }

  const data = response.data || {};
  const returnedConversation =
    data.conversationId || data.conversation?.id || data.data?.conversationId || conversationId || null;
  const messageId = data.messageId || data.message?.id || data.id || data.data?.messageId || null;
  return {
    ok: response.ok,
    status: response.status,
    conversationId: returnedConversation,
    messageId,
    raw: data,
    waMe: phone
      ? `https://wa.me/${phoneForWa(phone)}?text=${encodeURIComponent(message)}`
      : null,
  };
}

export async function sendTemplate(env, { accountId, profileId, conversationId, phone, templateName, language, params }) {
  const account = accountFrom(env, accountId);
  const name = str(templateName, 120);
  if (!name) throw new HttpError(400, 'templateName obrigatório', 'VALIDATION');
  if (!account) throw new HttpError(503, 'ZERNIO_ACCOUNT_ID não configurado', 'ZERNIO_ACCOUNT_MISSING');
  const templateParams = (Array.isArray(params) ? params : []).slice(0, 20).map((value) => str(value, 300));
  const lang = str(language, 20) || 'pt_BR';

  let response;
  if (conversationId) {
    response = await zernioFetch(env, `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: account,
        template: {
          elements: [
            {
              name,
              language: { code: lang },
              components: templateParams.length
                ? [{ type: 'body', parameters: templateParams.map((text) => ({ type: 'text', text })) }]
                : [],
            },
          ],
        },
      }),
    });
  } else {
    response = await zernioFetch(env, '/v1/inbox/conversations', {
      method: 'POST',
      body: JSON.stringify({
        accountId: account,
        profileId: str(profileId || env.ZERNIO_PROFILE_ID, 120) || undefined,
        participantId: phoneForWa(phone),
        templateName: name,
        templateLanguage: lang,
        templateParams,
      }),
    });
  }
  return {
    ok: response.ok,
    status: response.status,
    conversationId:
      response.data?.conversationId || response.data?.conversation?.id || conversationId || null,
    messageId: response.data?.messageId || response.data?.message?.id || response.data?.id || null,
    raw: response.data,
  };
}

export async function listConversations(env, { accountId, limit = 50 } = {}) {
  const account = accountFrom(env, accountId);
  if (!account) return { ok: false, reason: 'account_missing', conversations: [] };
  const query = new URLSearchParams({
    accountId: account,
    platform: 'whatsapp',
    limit: String(Math.min(100, Math.max(1, num(limit, 50, 1, 100)))),
  });
  if (env.ZERNIO_PROFILE_ID) query.set('profileId', env.ZERNIO_PROFILE_ID);
  const response = await zernioFetch(env, `/v1/inbox/conversations?${query.toString()}`);
  if (!response.ok) return { ok: false, reason: 'provider_error', status: response.status, conversations: [], raw: response.data };
  const data = response.data || {};
  const list =
    data.conversations ||
    data.data?.conversations ||
    data.data ||
    data.items ||
    [];
  return { ok: true, conversations: Array.isArray(list) ? list : [] };
}

export async function getConversation(env, { conversationId, accountId }) {
  const query = new URLSearchParams({ accountId: accountFrom(env, accountId) });
  return zernioFetch(
    env,
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}?${query.toString()}`
  );
}

export function extractWebhookSignature(req) {
  return (
    req.headers.get('X-Zernio-Signature') ||
    req.headers.get('X-Zernio-Event-Signature') ||
    req.headers.get('X-Zernio-Webhook-Signature') ||
    ''
  );
}

export async function verifyWebhook(req, rawBody, env) {
  const secret = env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) {
    throw new HttpError(503, 'Configure ZERNIO_WEBHOOK_SECRET para receber eventos', 'WEBHOOK_NOT_CONFIGURED');
  }
  const header = extractWebhookSignature(req);
  if (!header) return { ok: false, reason: 'signature_missing' };
  const timestamp = req.headers.get('X-Zernio-Timestamp') || '';
  if (timestamp) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'timestamp_invalid' };
  }
  const normalized = header.replace(/^sha256=/i, '').trim().toLowerCase();
  const payloads = [rawBody];
  if (timestamp) payloads.push(`${timestamp}.${rawBody}`);
  for (const payload of payloads) {
    const expected = await hmacHex(secret, payload);
    if (timingSafeEqual(expected, normalized)) return { ok: true };
  }
  return { ok: false, reason: 'signature_invalid' };
}

export function parseWebhook(payload) {
  const event = str(payload.event || payload.type || payload.eventType, 80);
  const account = payload.account || {};
  const conversation = payload.conversation || {};
  const message = payload.message || payload.data?.message || {};
  const sender = payload.sender || message.sender || payload.participant || {};
  const text =
    message.text?.body ??
    (typeof message.text === 'string' ? message.text : null) ??
    payload.text?.body ??
    (typeof payload.text === 'string' ? payload.text : null) ??
    message.body ??
    payload.body ??
    '';
  const fromMe =
    message.fromMe === true ||
    message.direction === 'outbound' ||
    message.direction === 'out' ||
    payload.direction === 'outbound' ||
    sender.type === 'business';
  return {
    event,
    accountId: str(account.accountId || payload.accountId || account.id, 120),
    profileId: str(account.profileId || payload.profileId, 120),
    conversationId: str(conversation.id || payload.conversationId || message.conversationId, 160),
    messageId: str(message.id || payload.messageId || payload.id, 180),
    text: str(text, 4096),
    fromMe,
    platform: str(payload.platform || account.platform || 'whatsapp', 30),
    contactPhone: str(
      conversation.participantId || sender.phone || sender.id || payload.participantId || payload.from,
      40
    ),
    contactName: str(conversation.participantName || sender.name || payload.participantName, 120),
    timestamp: str(payload.timestamp || message.timestamp || message.createdAt, 60),
    messageType: str(message.type || payload.messageType || 'text', 30),
    raw: payload,
  };
}
