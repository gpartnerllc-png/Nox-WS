import {
  HttpError,
  baseHeaders,
  errorResponse,
  json,
} from './lib/http.js';
import {
  cleanupAuth,
  handleApprove,
  handleAudit,
  handleBootstrap,
  handleChangePassword,
  handleDeleteUser,
  handleForgot,
  handleListUsers,
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
  handleReset,
  handleSetRole,
  handleSetUserDoc,
  handleTrackUser,
  requireAuth,
} from './lib/auth.js';
import {
  createSale,
  exportAll,
  getDashboard,
  getSync,
  listLeads,
  listPeople,
  listProducts,
  listSales,
  lookupCep,
  lookupCnpj,
  removePerson,
  removeProduct,
  upsertLead,
  upsertPerson,
  upsertProduct,
} from './data.js';
import {
  handleAsaasCheckoutCreate,
  handleAsaasPixCreate,
  handleAsaasStatus,
  handleAsaasWebhookRoute,
  handleApplePaySession,
  handleApplePayStatus,
  handleInterPixCreate,
  handleInterStatus,
  handlePaymentDetail,
  handlePaymentsList,
  handleProvidersStatus,
  handleUpiConfirm,
  handleUpiCreate,
} from './checkout.js';
import {
  handleWaAiReply,
  handleWaConfigGet,
  handleWaConfigUpdate,
  handleWaConversation,
  handleWaConversations,
  handleWaMarkRead,
  handleWaSend,
  handleWaSendNew,
  handleWaStatus,
  handleWaSync,
  handleWaToggleAi,
  handleLegacyBroadcast,
  handleLegacyWaSend,
  handleZernioWebhook,
} from './whatsapp.js';
import {
  identifyAndCharge,
  listConsumos,
  listFrigobar,
  listGuests,
  registerPalm,
  replenishFrigobar,
  upsertFrigobarItem,
} from './hotel.js';
import { aiChat, aiInsights, aiConfigured, aiProviderInfo } from './ai.js';
import { zernioConfigured } from './providers/zernio.js';
import { asaasConfigured } from './providers/asaas.js';
import { interConfigured } from './providers/inter.js';
import { upiConfigured } from './providers/upi.js';
import { applePayStatus } from './providers/applepay.js';

const VERSION = '2.2.0';

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function health(env) {
  return {
    ok: true,
    service: 'noxmob-api',
    worker: 'waitron-server',
    version: VERSION,
    env: env.ENV || 'production',
    agora: new Date().toISOString(),
    capabilities: {
      d1: Boolean(env.DB),
      assets: Boolean(env.ASSETS),
      ai: aiConfigured(env),
      aiProvedor: aiProviderInfo(env),
      zernio: zernioConfigured(env),
      webhookAssinado: Boolean(env.ZERNIO_WEBHOOK_SECRET),
      asaas: asaasConfigured(env),
      inter: interConfigured(env),
      interMtls: Boolean(env.INTER_MTLS),
      upi: upiConfigured(env),
      applePay: applePayStatus(env).configurado,
      pix: asaasConfigured(env) || interConfigured(env),
    },
    rotas: [
      'GET /health',
      'POST /auth/login · /auth/register · /auth/forgot · /auth/reset · /auth/bootstrap',
      'GET /auth/me · /auth/users · /auth/users/lookup · /auth/audit',
      'POST /auth/users/doc · /auth/role · /auth/delete',
      'GET|POST /api/produtos · /api/vendas · /api/pessoas · /api/leads',
      'GET /api/sync · /api/dashboard · /api/export',
      'POST /api/ai/chat · GET /api/ai/insights',
      'GET|POST /api/pagamentos · /api/pay/asaas/* · /api/pay/inter/* · /api/pay/upi',
      'GET|POST /api/wa/* · POST /webhook/zernio',
      'GET /api/hotel/hospedes · POST /api/palm/* · GET /api/frigobar/estoque',
    ],
  };
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function secureAsset(response, req) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  const path = new URL(req.url).pathname;
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (path === '/sw.js' || path.endsWith('.html') || !path.includes('.')) {
    headers.set('Cache-Control', 'no-cache');
  } else if (/\.(css|js|webmanifest)$/.test(path)) {
    headers.set('Cache-Control', 'no-cache');
  } else if (/\.(png|svg|ico)$/.test(path)) {
    headers.set('Cache-Control', 'public, max-age=86400');
  }
  if (req.url.startsWith('https:')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveAsset(req, env) {
  if (!env.ASSETS) return null;
  const response = await env.ASSETS.fetch(req);
  if (response.status !== 404) return secureAsset(response, req);
  const accept = req.headers.get('Accept') || '';
  if (accept.includes('text/html')) {
    const indexUrl = new URL('/index.html', req.url);
    const fallback = await env.ASSETS.fetch(
      new Request(indexUrl.toString(), {
        method: 'GET',
        headers: req.headers,
        redirect: 'manual',
      })
    );
    return secureAsset(fallback, req);
  }
  return response;
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders(req, env) });
  }

  /* ── Saúde e raiz ───────────────────────────────────── */
  if ((path === '/health' || path === '/api/health') && (method === 'GET' || method === 'HEAD')) {
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          ...baseHeaders(req, env),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    return json(health(env), 200, req, env);
  }
  if (path === '/' && method === 'GET') {
    if (env.ASSETS) {
      const asset = await serveAsset(req, env);
      if (asset) return asset;
    }
    return json(health(env), 200, req, env);
  }

  /* ── Verificação de domínio Apple Pay ────────────────── */
  if (path === '/.well-known/apple-developer-merchantid-domain-association' && method === 'GET') {
    const association = env.APPLE_PAY_DOMAIN_ASSOCIATION;
    if (!association) {
      throw new HttpError(404, 'Arquivo de associação Apple Pay não configurado', 'APPLE_PAY_NOT_CONFIGURED');
    }
    return new Response(association, {
      status: 200,
      headers: {
        ...baseHeaders(req, env),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  /* ── Consultas públicas de cadastro ──────────────────── */
  const cnpjMatch = path.match(/^\/cnpj\/([^/]+)$/);
  if (cnpjMatch && method === 'GET') {
    return json(await lookupCnpj(env, ctx, decodeParam(cnpjMatch[1])), 200, req, env);
  }
  const cepMatch = path.match(/^\/cep\/([^/]+)$/);
  if (cepMatch && method === 'GET') {
    return json(await lookupCep(env, ctx, decodeParam(cepMatch[1]), req), 200, req, env);
  }

  /* ── Autenticação ────────────────────────────────────── */
  if (path === '/auth/login' && method === 'POST') {
    return json(await handleLogin(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/register' && method === 'POST') {
    return json(await handleRegister(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/forgot' && method === 'POST') {
    return json(await handleForgot(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/reset' && method === 'POST') {
    return json(await handleReset(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/bootstrap' && method === 'POST') {
    return json(await handleBootstrap(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/me' && method === 'GET') {
    return json(await handleMe(req, env), 200, req, env);
  }
  if (path === '/auth/logout' && method === 'POST') {
    return json(await handleLogout(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/change-password' && method === 'POST') {
    return json(await handleChangePassword(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/approve' && method === 'POST') {
    return json(await handleApprove(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/users' && method === 'GET') {
    return json(await handleListUsers(req, env), 200, req, env);
  }
  if (path === '/auth/users/lookup' && method === 'GET') {
    return json(await handleTrackUser(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/users/doc' && method === 'POST') {
    return json(await handleSetUserDoc(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/role' && method === 'POST') {
    return json(await handleSetRole(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/delete' && method === 'POST') {
    return json(await handleDeleteUser(req, env, ctx), 200, req, env);
  }
  if (path === '/auth/audit' && method === 'GET') {
    return json(await handleAudit(req, env), 200, req, env);
  }

  /* ── Produtos ────────────────────────────────────────── */
  if (path === '/api/produtos' && method === 'GET') {
    await requireAuth(req, env);
    return json(await listProducts(env, url), 200, req, env);
  }
  if (path === '/api/produtos' && method === 'POST') {
    await requireAuth(req, env);
    const body = await req.json();
    return json(await upsertProduct(env, body), 200, req, env);
  }
  const productMatch = path.match(/^\/api\/produtos\/([^/]+)$/);
  if (productMatch && method === 'PUT') {
    await requireAuth(req, env, ['admin', 'gerente']);
    const body = await req.json();
    body.sku = decodeParam(productMatch[1]);
    return json(await upsertProduct(env, body), 200, req, env);
  }
  if (productMatch && method === 'DELETE') {
    await requireAuth(req, env, ['admin', 'gerente']);
    return json(await removeProduct(env, decodeParam(productMatch[1])), 200, req, env);
  }

  /* ── Pessoas e leads ─────────────────────────────────── */
  if (path === '/api/pessoas' && method === 'GET') {
    await requireAuth(req, env);
    return json(await listPeople(env), 200, req, env);
  }
  if (path === '/api/pessoas' && method === 'POST') {
    await requireAuth(req, env);
    return json(await upsertPerson(env, await req.json()), 200, req, env);
  }
  const personMatch = path.match(/^\/api\/pessoas\/(\d+)$/);
  if (personMatch && method === 'DELETE') {
    await requireAuth(req, env, ['admin', 'gerente']);
    return json(await removePerson(env, personMatch[1]), 200, req, env);
  }
  if (path === '/api/leads' && method === 'GET') {
    await requireAuth(req, env);
    return json(await listLeads(env), 200, req, env);
  }
  if (path === '/api/leads' && method === 'POST') {
    await requireAuth(req, env);
    return json(await upsertLead(env, await req.json()), 200, req, env);
  }

  /* ── Vendas, sincronização e painel ──────────────────── */
  if (path === '/api/vendas' && method === 'GET') {
    await requireAuth(req, env);
    return json(await listSales(env, url), 200, req, env);
  }
  if (path === '/api/vendas' && method === 'POST') {
    const user = await requireAuth(req, env);
    return json(await createSale(env, await req.json(), user), 200, req, env);
  }
  if (path === '/api/sync' && method === 'GET') {
    await requireAuth(req, env);
    return json(await getSync(env), 200, req, env);
  }
  if (path === '/api/dashboard' && method === 'GET') {
    await requireAuth(req, env);
    return json(await getDashboard(env), 200, req, env);
  }
  if (path === '/api/export' && method === 'GET') {
    await requireAuth(req, env, ['admin']);
    const data = await exportAll(env);
    return json(data, 200, req, env, {
      'Content-Disposition': `attachment; filename="noxmob-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  /* ── Inteligência artificial ─────────────────────────── */
  if (path === '/api/ai/chat' && method === 'POST') {
    const user = await requireAuth(req, env);
    return json(await aiChat(env, user, await req.json()), 200, req, env);
  }
  if (path === '/api/ai/insights' && (method === 'GET' || method === 'POST')) {
    await requireAuth(req, env);
    return json(await aiInsights(env), 200, req, env);
  }

  /* ── Pagamentos ──────────────────────────────────────── */
  if (path === '/api/pagamentos/providers' && method === 'GET') {
    return json(await handleProvidersStatus(req, env), 200, req, env);
  }
  if (path === '/api/pagamentos' && method === 'GET') {
    return json(await handlePaymentsList(req, env, url), 200, req, env);
  }
  const paymentMatch = path.match(/^\/api\/pagamentos\/(\d+)$/);
  if (paymentMatch && method === 'GET') {
    return json(await handlePaymentDetail(req, env, paymentMatch[1]), 200, req, env);
  }

  if ((path === '/pay/asaas/pix' || path === '/api/pay/asaas/pix') && method === 'POST') {
    return json(await handleAsaasPixCreate(req, env, ctx), 200, req, env);
  }
  if (path === '/api/pay/asaas/checkout' && method === 'POST') {
    return json(await handleAsaasCheckoutCreate(req, env, ctx), 200, req, env);
  }
  const asaasStatusMatch = path.match(/^\/api\/pay\/asaas\/status\/([^/]+)$/);
  if (asaasStatusMatch && method === 'GET') {
    return json(await handleAsaasStatus(req, env, decodeParam(asaasStatusMatch[1])), 200, req, env);
  }
  if ((path === '/pay/asaas/webhook' || path === '/api/pay/asaas/webhook') && method === 'POST') {
    return json(await handleAsaasWebhookRoute(req, env), 200, req, env);
  }

  if ((path === '/pay/inter/pix' || path === '/api/pay/inter/pix') && method === 'POST') {
    return json(await handleInterPixCreate(req, env, ctx), 200, req, env);
  }
  const interStatusMatch = path.match(/^\/api\/pay\/inter\/status\/([^/]+)$/);
  if (interStatusMatch && method === 'GET') {
    return json(await handleInterStatus(req, env, decodeParam(interStatusMatch[1])), 200, req, env);
  }

  if (path === '/api/pay/upi' && method === 'POST') {
    return json(await handleUpiCreate(req, env, ctx), 200, req, env);
  }
  if (path === '/api/pay/upi/confirm' && method === 'POST') {
    return json(await handleUpiConfirm(req, env, ctx), 200, req, env);
  }
  if (path === '/api/pay/applepay/status' && method === 'GET') {
    return json(await handleApplePayStatus(req, env), 200, req, env);
  }
  if (path === '/api/pay/applepay/session' && method === 'POST') {
    return json(await handleApplePaySession(req, env, ctx), 200, req, env);
  }

  /* ── WhatsApp ────────────────────────────────────────── */
  if (path === '/api/wa/status' && method === 'GET') {
    return json(await handleWaStatus(req, env), 200, req, env);
  }
  if (path === '/api/wa/config' && method === 'GET') {
    return json(await handleWaConfigGet(req, env), 200, req, env);
  }
  if (path === '/api/wa/config' && (method === 'PUT' || method === 'POST')) {
    return json(await handleWaConfigUpdate(req, env, ctx), 200, req, env);
  }
  if (path === '/api/wa/conversations' && method === 'GET') {
    return json(await handleWaConversations(req, env, url), 200, req, env);
  }
  if (path === '/api/wa/sync' && method === 'POST') {
    return json(await handleWaSync(req, env, ctx), 200, req, env);
  }
  if (path === '/api/wa/send' && method === 'POST') {
    return json(await handleWaSendNew(req, env, ctx), 200, req, env);
  }
  const waConversationMatch = path.match(/^\/api\/wa\/conversations\/([^/]+)$/);
  if (waConversationMatch && method === 'GET') {
    return json(await handleWaConversation(req, env, decodeParam(waConversationMatch[1])), 200, req, env);
  }
  const waMessagesMatch = path.match(/^\/api\/wa\/conversations\/([^/]+)\/messages$/);
  if (waMessagesMatch && method === 'POST') {
    return json(await handleWaSend(req, env, ctx, decodeParam(waMessagesMatch[1])), 200, req, env);
  }
  const waReadMatch = path.match(/^\/api\/wa\/conversations\/([^/]+)\/read$/);
  if (waReadMatch && method === 'POST') {
    return json(await handleWaMarkRead(req, env, decodeParam(waReadMatch[1])), 200, req, env);
  }
  const waAiMatch = path.match(/^\/api\/wa\/conversations\/([^/]+)\/ai$/);
  if (waAiMatch && method === 'POST') {
    return json(await handleWaToggleAi(req, env, ctx, decodeParam(waAiMatch[1])), 200, req, env);
  }
  const waAiReplyMatch = path.match(/^\/api\/wa\/conversations\/([^/]+)\/ai-reply$/);
  if (waAiReplyMatch && method === 'POST') {
    return json(await handleWaAiReply(req, env, ctx, decodeParam(waAiReplyMatch[1])), 200, req, env);
  }
  if (path === '/wa/send' && method === 'POST') {
    return json(await handleLegacyWaSend(req, env, ctx), 200, req, env);
  }
  if (path === '/wa/broadcast' && method === 'POST') {
    return json(await handleLegacyBroadcast(req, env, ctx), 200, req, env);
  }
  if ((path === '/webhook/zernio' || path === '/api/wa/webhook') && method === 'POST') {
    return json(await handleZernioWebhook(req, env, ctx), 200, req, env);
  }

  /* ── Hotel, palm e frigobar ──────────────────────────── */
  if (path === '/api/palm/register' && method === 'POST') {
    return json(await registerPalm(req, env, ctx), 200, req, env);
  }
  if (path === '/api/palm/identify-and-charge' && method === 'POST') {
    return json(await identifyAndCharge(req, env, ctx), 200, req, env);
  }
  if ((path === '/api/palm/consumos' || path === '/api/hotel/consumos') && method === 'GET') {
    return json(await listConsumos(req, env, url), 200, req, env);
  }
  if (path === '/api/hotel/hospedes' && method === 'GET') {
    return json(await listGuests(req, env), 200, req, env);
  }
  if (path === '/api/frigobar/estoque' && method === 'GET') {
    return json(await listFrigobar(req, env), 200, req, env);
  }
  if (path === '/api/frigobar/reposicao' && method === 'POST') {
    return json(await replenishFrigobar(req, env, ctx), 200, req, env);
  }
  if (path === '/api/frigobar/itens' && method === 'POST') {
    return json(await upsertFrigobarItem(req, env, ctx), 200, req, env);
  }

  /* ── Assets estáticos (quando o Worker serve o PWA) ──── */
  if (env.ASSETS && method === 'GET' && !/^\/(api|auth|pay|webhook)\//.test(path)) {
    const asset = await serveAsset(req, env);
    if (asset) return asset;
  }

  throw new HttpError(404, 'Rota não encontrada', 'NOT_FOUND', { path });
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error, req, env);
      }
      if (error?.name === 'SyntaxError') {
        return errorResponse(new HttpError(400, 'JSON inválido', 'VALIDATION'), req, env);
      }
      console.error('Worker error:', error?.stack || error);
      return errorResponse(error, req, env);
    }
  },

  async scheduled(event, env, ctx) {
    const jobs = [cleanupAuth(env)];
    if (env.DB) {
      jobs.push(
        env.DB.prepare("DELETE FROM sync_receipts WHERE criado_em < datetime('now', '-90 days')")
          .run()
          .catch((error) => console.error('Limpeza sync_receipts:', error?.message || error))
      );
    }
    ctx.waitUntil(Promise.all(jobs));
  },
};
