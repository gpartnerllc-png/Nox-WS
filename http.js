const DEFAULT_ORIGINS = [
  'https://ws.droppfy.com',
  'https://droppfy.com',
  'https://www.droppfy.com',
  'https://waitron-server.contatodroppfy.workers.dev',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = allowed.length ? allowed : DEFAULT_ORIGINS;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-API-Key, X-Bootstrap-Token, Idempotency-Key, X-Request-Id',
    'Access-Control-Expose-Headers': 'X-Request-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (list.includes('*')) headers['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function baseHeaders(req, env) {
  return {
    ...corsHeaders(req, env),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'X-Request-Id': req.headers.get('X-Request-Id') || crypto.randomUUID(),
  };
}

export function json(data, status, req, env, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...baseHeaders(req, env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

export function text(body, status, req, env, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      ...baseHeaders(req, env),
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    },
  });
}

export function errorResponse(err, req, env) {
  const status = err instanceof HttpError ? err.status : 500;
  const message =
    err instanceof HttpError ? err.message : 'Erro interno. Tente novamente em instantes.';
  if (!(err instanceof HttpError)) console.error('Unhandled error:', err?.stack || err);
  return json(
    {
      ok: false,
      erro: message,
      codigo: err?.code || 'INTERNAL',
      detalhes: err instanceof HttpError ? err.details : null,
      requestId: req.headers.get('CF-Ray') || undefined,
    },
    status,
    req,
    env
  );
}

export async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const declared = Number(req.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Corpo da requisição muito grande');
  const raw = await req.text();
  if (!raw) return {};
  if (raw.length > maxBytes) throw new HttpError(413, 'Corpo da requisição muito grande');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('not object');
    return value;
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizePhoneBR(value) {
  let digits = onlyDigits(value);
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  return digits ? '+' + digits : '';
}

export function phoneForWa(value) {
  return onlyDigits(normalizePhoneBR(value));
}

export function str(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function num(value, fallback = 0, min = -Infinity, max = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function money(value) {
  return Math.round(num(value, 0, 0, 1e9) * 100) / 100;
}

export function bool(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ''));
}

export function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

export function isAdmin(user) {
  return user?.papel === 'admin' || user?.via === 'api-key';
}

export function canManage(user) {
  return isAdmin(user) || user?.papel === 'gerente';
}

export function requireFields(body, fields) {
  const missing = fields.filter((field) => !String(body[field] ?? '').trim());
  if (missing.length) {
    throw new HttpError(400, 'Preencha os campos obrigatórios', 'VALIDATION', { fields: missing });
  }
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}
