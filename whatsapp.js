import {
  HttpError,
  bool,
  onlyDigits,
  phoneForWa,
  readJson,
  str,
} from './lib/http.js';
import { audit, rateLimit, requireAuth } from './lib/auth.js';
import { aiConfigured, aiProviderInfo, generateWhatsAppReply } from './ai.js';
import { sha256Hex } from './lib/security.js';
import {
  listConversations,
  parseWebhook,
  sendTemplate,
  sendText,
  verifyWebhook,
  zernioConfigured,
} from './providers/zernio.js';

const CONFIG_DEFAULTS = {
  id: 1,
  ia_ativa: 1,
  account_id: '',
  profile_id: '',
  nome_empresa: 'NoxMob',
  prompt_sistema: '',
  mensagem_boas_vindas: '',
  mensagem_fora_horario: '',
  horario: '',
};

const AUTO_REPLY_HOURLY_LIMIT = 25;
const OPT_OUT = /^(pare|parar|sair|descadastr\w*|n[aã]o quero|remover)([\s!.].*)?$/i;

function dbRequired(env) {
  if (!env.DB) throw new HttpError(503, 'D1 não conectado', 'DB_REQUIRED');
  return env.DB;
}

export async function getWaConfig(env) {
  if (!env.DB) return { ...CONFIG_DEFAULTS };
  const row = await env.DB.prepare('SELECT * FROM wa_config WHERE id = 1').first();
  return row ? { ...CONFIG_DEFAULTS, ...row } : { ...CONFIG_DEFAULTS };
}

function isoNow(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function syntheticConversationId(phone) {
  return `wa:${onlyDigits(phone) || 'desconhecido'}`;
}

function isSynthetic(conversationId) {
  return !conversationId || String(conversationId).startsWith('wa:');
}

function providerConversationId(conversation) {
  return isSynthetic(conversation?.conversation_id) ? null : conversation.conversation_id;
}

function messagePlaceholder(type) {
  const map = {
    image: '[imagem recebida]',
    video: '[vídeo recebido]',
    audio: '[áudio recebido]',
    document: '[documento recebido]',
    sticker: '[figurinha recebida]',
    location: '[localização recebida]',
    contacts: '[contato recebido]',
    button: '[resposta de botão]',
  };
  return map[String(type || '').toLowerCase()] || '[mensagem recebida]';
}

function normalizeConversation(raw = {}) {
  const phone =
    raw.participantId ||
    raw.phone ||
    raw.contact?.phone ||
    raw.contact?.id ||
    raw.participant?.id ||
    '';
  const id =
    str(raw.id || raw.conversationId || raw.conversation?.id, 160) ||
    syntheticConversationId(phone);
  const lastMessage =
    raw.lastMessage?.text?.body ||
    (typeof raw.lastMessage === 'string' ? raw.lastMessage : '') ||
    raw.lastMessageText ||
    raw.preview ||
    '';
  return {
    conversationId: id,
    accountId: str(raw.accountId || raw.account?.id, 120),
    profileId: str(raw.profileId || raw.profile?.id, 120),
    contact: onlyDigits(phone) || str(phone, 40),
    name: str(raw.participantName || raw.name || raw.contact?.name || raw.displayName, 120),
    lastMessage: str(lastMessage, 500),
    lastAt: isoNow(raw.updatedAt || raw.lastMessageAt || raw.timestamp),
    unread: Math.max(0, Math.trunc(Number(raw.unreadCount || raw.unread || 0) || 0)),
  };
}

export async function upsertConversation(env, data, { unreadIncrement = 0 } = {}) {
  const db = dbRequired(env);
  const conversationId = str(data.conversationId || data.conversation_id, 160);
  if (!conversationId) return null;
  const now = isoNow(data.lastAt || data.at);
  await db
    .prepare(
      `INSERT INTO wa_conversas
         (conversation_id, account_id, profile_id, contato, nome, canal,
          ultima_mensagem, ultima_em, nao_lidas, atualizado_em)
       VALUES (?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         account_id = COALESCE(NULLIF(excluded.account_id, ''), wa_conversas.account_id),
         profile_id = COALESCE(NULLIF(excluded.profile_id, ''), wa_conversas.profile_id),
         contato = COALESCE(NULLIF(excluded.contato, ''), wa_conversas.contato),
         nome = COALESCE(NULLIF(excluded.nome, ''), wa_conversas.nome),
         ultima_mensagem = CASE
           WHEN excluded.ultima_em >= COALESCE(wa_conversas.ultima_em, '') THEN excluded.ultima_mensagem
           ELSE wa_conversas.ultima_mensagem END,
         ultima_em = CASE
           WHEN excluded.ultima_em >= COALESCE(wa_conversas.ultima_em, '') THEN excluded.ultima_em
           ELSE wa_conversas.ultima_em END,
         nao_lidas = wa_conversas.nao_lidas + ?,
         atualizado_em = excluded.atualizado_em`
    )
    .bind(
      conversationId,
      str(data.accountId || data.account_id, 120) || null,
      str(data.profileId || data.profile_id, 120) || null,
      onlyDigits(data.contact) || str(data.contact, 40) || null,
      str(data.name, 120) || null,
      str(data.lastMessage, 500) || null,
      now,
      unreadIncrement,
      now
    )
    .run();
  return db
    .prepare('SELECT * FROM wa_conversas WHERE conversation_id = ?')
    .bind(conversationId)
    .first();
}

export async function saveMessage(env, data) {
  const db = dbRequired(env);
  const conversationId = str(data.conversationId, 160);
  if (!conversationId) return null;
  const messageId = str(data.messageId, 180) || `local-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO wa_mensagens
         (conversation_id, message_id, direcao, origem, texto, tipo, status, autor, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      conversationId,
      messageId,
      data.direction === 'out' ? 'out' : 'in',
      str(data.origin, 40) || null,
      str(data.text, 4096) || null,
      str(data.type, 30) || 'text',
      str(data.status, 30) || 'recebido',
      str(data.author, 180) || null,
      data.payload ? JSON.stringify(data.payload).slice(0, 20000) : null
    )
    .run();
  return messageId;
}

async function updateMessageStatus(env, messageId, status) {
  if (!env.DB || !messageId) return;
  await env.DB.prepare('UPDATE wa_mensagens SET status = ? WHERE message_id = ?')
    .bind(str(status, 30), messageId)
    .run()
    .catch(() => {});
}

async function getConversationById(env, id) {
  return dbRequired(env)
    .prepare('SELECT * FROM wa_conversas WHERE conversation_id = ?')
    .bind(id)
    .first();
}

function replyAllowed(config, conversation) {
  if (!bool(config?.ia_ativa, true)) return { ok: false, reason: 'ia_global_desligada' };
  if (!conversation) return { ok: false, reason: 'conversa_ausente' };
  if (!bool(conversation.ia_ativa, true)) return { ok: false, reason: 'ia_da_conversa_desligada' };
  if (conversation.ia_pausada_ate && Date.parse(conversation.ia_pausada_ate) > Date.now()) {
    return { ok: false, reason: 'ia_pausada' };
  }
  if (bool(conversation.arquivada, false)) return { ok: false, reason: 'conversa_arquivada' };
  return { ok: true };
}

async function autoReply(env, conversation, event, config) {
  const permission = replyAllowed(config, conversation);
  if (!permission.ok) return { skipped: permission.reason };
  const incoming = str(event.text, 2000);
  if (!incoming) return { skipped: 'sem_texto' };

  if (OPT_OUT.test(incoming)) {
    await env.DB.prepare(
      `UPDATE wa_conversas
       SET ia_ativa = 0, ia_pausada_ate = datetime('now', '+30 days'), atualizado_em = ?
       WHERE conversation_id = ?`
    )
      .bind(new Date().toISOString(), conversation.conversation_id)
      .run()
      .catch(() => {});
    return { skipped: 'opt_out' };
  }

  const limit = await rateLimit(
    env,
    `wa-ai:${conversation.conversation_id}`,
    AUTO_REPLY_HOURLY_LIMIT,
    3600
  );
  if (!limit.ok) return { skipped: 'rate_limit' };

  const history = await env.DB.prepare(
    `SELECT direcao, texto FROM wa_mensagens
     WHERE conversation_id = ? ORDER BY id DESC LIMIT 10`
  )
    .bind(conversation.conversation_id)
    .all()
    .then((result) => (result.results || []).reverse())
    .catch(() => []);

  const text = await generateWhatsAppReply(env, { config, history, incoming });
  const response = await sendText(env, {
    accountId: conversation.account_id || config.account_id,
    profileId: conversation.profile_id || config.profile_id,
    conversationId: providerConversationId(conversation),
    phone: conversation.contato,
    text,
  });

  const status = response.ok ? 'enviado' : 'erro';
  await saveMessage(env, {
    conversationId: conversation.conversation_id,
    messageId: response.messageId,
    direction: 'out',
    origin: 'ia',
    text,
    status,
    author: 'NoxMob IA',
    payload: response.raw,
  });
  if (response.ok) {
    await upsertConversation(
      env,
      {
        conversationId: conversation.conversation_id,
        accountId: conversation.account_id,
        profileId: conversation.profile_id,
        contact: conversation.contato,
        name: conversation.nome,
        lastMessage: text,
        lastAt: new Date().toISOString(),
      },
      { unreadIncrement: 0 }
    );
  }
  return { ok: response.ok, status, conversationId: conversation.conversation_id };
}

/* ============================================================
   HANDLERS AUTENTICADOS
   ============================================================ */

export async function handleWaStatus(req, env) {
  await requireAuth(req, env);
  const config = await getWaConfig(env);
  const ia = aiProviderInfo(env);
  let stats = { conversas: 0, nao_lidas: 0, mensagens_hoje: 0, com_ia: 0 };
  if (env.DB) {
    try {
      const [conv, msgs] = await env.DB.batch([
        env.DB.prepare(
          `SELECT COUNT(*) AS conversas,
                  COALESCE(SUM(nao_lidas), 0) AS nao_lidas,
                  SUM(CASE WHEN ia_ativa = 1 THEN 1 ELSE 0 END) AS com_ia
           FROM wa_conversas WHERE arquivada = 0`
        ),
        env.DB.prepare(
          "SELECT COUNT(*) AS total FROM wa_mensagens WHERE date(criado_em) = date('now')"
        ),
      ]);
      stats = {
        conversas: Number(conv.results?.[0]?.conversas || 0),
        nao_lidas: Number(conv.results?.[0]?.nao_lidas || 0),
        com_ia: Number(conv.results?.[0]?.com_ia || 0),
        mensagens_hoje: Number(msgs.results?.[0]?.total || 0),
      };
    } catch {
      /* banco novo sem tabelas de WhatsApp */
    }
  }
  return {
    ok: true,
    zernio: {
      configurado: zernioConfigured(env),
      contaConfigurada: Boolean(config.account_id || env.ZERNIO_ACCOUNT_ID),
      perfilConfigurado: Boolean(config.profile_id || env.ZERNIO_PROFILE_ID),
    },
    ia: {
      configurada: aiConfigured(env),
      ativa: bool(config.ia_ativa, true),
      modelo: ia.ativo === 'grok' ? ia.grok.modelo : ia.llama.modelo,
      provedor: ia.ativo,
      provedores: ia,
    },
    webhook: {
      configurado: Boolean(env.ZERNIO_WEBHOOK_SECRET),
      url: '/webhook/zernio',
    },
    config,
    stats,
  };
}

export async function handleWaConfigGet(req, env) {
  await requireAuth(req, env);
  return { ok: true, config: await getWaConfig(env), ia_configurada: aiConfigured(env) };
}

export async function handleWaConfigUpdate(req, env, ctx) {
  const user = await requireAuth(req, env, ['admin', 'gerente']);
  const body = await readJson(req);
  const db = dbRequired(env);
  const current = await getWaConfig(env);
  const next = {
    ia_ativa: body.ia_ativa === undefined ? current.ia_ativa : bool(body.ia_ativa, true) ? 1 : 0,
    account_id: str(body.account_id ?? current.account_id, 120) || null,
    profile_id: str(body.profile_id ?? current.profile_id, 120) || null,
    nome_empresa: str(body.nome_empresa ?? current.nome_empresa, 80) || 'NoxMob',
    prompt_sistema: str(body.prompt_sistema ?? current.prompt_sistema, 3000) || null,
    mensagem_boas_vindas: str(body.mensagem_boas_vindas ?? current.mensagem_boas_vindas, 1000) || null,
    mensagem_fora_horario: str(body.mensagem_fora_horario ?? current.mensagem_fora_horario, 1000) || null,
    horario: str(body.horario ?? current.horario, 200) || null,
  };
  await db
    .prepare(
      `INSERT INTO wa_config
         (id, ia_ativa, account_id, profile_id, nome_empresa, prompt_sistema,
          mensagem_boas_vindas, mensagem_fora_horario, horario, atualizado_em)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         ia_ativa = excluded.ia_ativa,
         account_id = excluded.account_id,
         profile_id = excluded.profile_id,
         nome_empresa = excluded.nome_empresa,
         prompt_sistema = excluded.prompt_sistema,
         mensagem_boas_vindas = excluded.mensagem_boas_vindas,
         mensagem_fora_horario = excluded.mensagem_fora_horario,
         horario = excluded.horario,
         atualizado_em = datetime('now')`
    )
    .bind(
      next.ia_ativa,
      next.account_id,
      next.profile_id,
      next.nome_empresa,
      next.prompt_sistema,
      next.mensagem_boas_vindas,
      next.mensagem_fora_horario,
      next.horario
    )
    .run();
  audit(env, ctx, {
    usuario: user.email,
    acao: 'whatsapp_config',
    entidade: 'wa_config',
    detalhe: { ia_ativa: next.ia_ativa, account_id: next.account_id },
  });
  return { ok: true, config: await getWaConfig(env) };
}

export async function handleWaConversations(req, env, url) {
  await requireAuth(req, env);
  const db = dbRequired(env);
  const q = str(url.searchParams.get('q'), 80);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 80));
  const includeArchived = url.searchParams.get('arquivadas') === '1';
  const clauses = [];
  const bindings = [];
  if (!includeArchived) clauses.push('arquivada = 0');
  if (q) {
    clauses.push('(nome LIKE ? OR contato LIKE ? OR ultima_mensagem LIKE ?)');
    const term = `%${q.replace(/[%_]/g, '\\$&')}%`;
    bindings.push(term, term, term);
  }
  bindings.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT * FROM wa_conversas ${where}
       ORDER BY COALESCE(ultima_em, atualizado_em) DESC LIMIT ?`
    )
    .bind(...bindings)
    .all();
  return { ok: true, conversas: results || [] };
}

export async function handleWaConversation(req, env, id) {
  await requireAuth(req, env);
  const conversation = await getConversationById(env, str(id, 160));
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada', 'NOT_FOUND');
  const { results } = await dbRequired(env)
    .prepare(
      `SELECT id, message_id, direcao, origem, texto, tipo, status, autor, criado_em
       FROM wa_mensagens WHERE conversation_id = ? ORDER BY id ASC LIMIT 200`
    )
    .bind(conversation.conversation_id)
    .all();
  return { ok: true, conversa: conversation, mensagens: results || [] };
}

export async function handleWaMarkRead(req, env, id) {
  await requireAuth(req, env);
  const result = await dbRequired(env)
    .prepare('UPDATE wa_conversas SET nao_lidas = 0, atualizado_em = ? WHERE conversation_id = ?')
    .bind(new Date().toISOString(), str(id, 160))
    .run();
  if (!result.meta?.changes) throw new HttpError(404, 'Conversa não encontrada', 'NOT_FOUND');
  return { ok: true };
}

export async function handleWaToggleAi(req, env, ctx, id) {
  const user = await requireAuth(req, env);
  const body = await readJson(req);
  const conversation = await getConversationById(env, str(id, 160));
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada', 'NOT_FOUND');
  const active = body.ativa === undefined ? !bool(conversation.ia_ativa, true) : bool(body.ativa, true);
  await dbRequired(env)
    .prepare(
      `UPDATE wa_conversas SET ia_ativa = ?, ia_pausada_ate = NULL, atualizado_em = ?
       WHERE conversation_id = ?`
    )
    .bind(active ? 1 : 0, new Date().toISOString(), conversation.conversation_id)
    .run();
  audit(env, ctx, {
    usuario: user.email,
    acao: 'whatsapp_ia_toggle',
    entidade: 'wa_conversas',
    entidade_id: conversation.conversation_id,
    detalhe: { ativa: active },
  });
  return { ok: true, ia_ativa: active };
}

export async function handleWaSend(req, env, ctx, id) {
  const user = await requireAuth(req, env);
  const body = await readJson(req);
  const text = str(body.text || body.message, 4096);
  if (!text) throw new HttpError(400, 'Mensagem vazia', 'VALIDATION');
  const conversation = await getConversationById(env, str(id, 160));
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada', 'NOT_FOUND');
  const config = await getWaConfig(env);

  let response;
  try {
    response = await sendText(env, {
      accountId: conversation.account_id || config.account_id,
      profileId: conversation.profile_id || config.profile_id,
      conversationId: providerConversationId(conversation),
      phone: conversation.contato,
      text,
    });
  } catch (error) {
    const waMe = conversation.contato
      ? `https://wa.me/${phoneForWa(conversation.contato)}?text=${encodeURIComponent(text)}`
      : null;
    await saveMessage(env, {
      conversationId: conversation.conversation_id,
      direction: 'out',
      origin: 'humano',
      text,
      status: 'fallback',
      author: user.email,
    });
    return { ok: false, fallback: Boolean(waMe), waMe, erro: error?.message || String(error) };
  }

  await saveMessage(env, {
    conversationId: conversation.conversation_id,
    messageId: response.messageId,
    direction: 'out',
    origin: 'humano',
    text,
    status: response.ok ? 'enviado' : 'erro',
    author: user.email,
    payload: response.raw,
  });
  await upsertConversation(env, {
    conversationId: conversation.conversation_id,
    accountId: conversation.account_id,
    profileId: conversation.profile_id,
    contact: conversation.contato,
    name: conversation.nome,
    lastMessage: text,
    lastAt: new Date().toISOString(),
  });
  audit(env, ctx, {
    usuario: user.email,
    acao: 'whatsapp_envio',
    entidade: 'wa_conversas',
    entidade_id: conversation.conversation_id,
  });
  return {
    ok: response.ok,
    fallback: !response.ok,
    waMe: response.waMe,
    messageId: response.messageId,
    status: response.status,
    provider: response.raw,
  };
}

export async function handleWaAiReply(req, env, ctx, id) {
  const user = await requireAuth(req, env);
  const conversation = await getConversationById(env, str(id, 160));
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada', 'NOT_FOUND');
  const config = await getWaConfig(env);
  const history = await env.DB.prepare(
    `SELECT direcao, texto FROM wa_mensagens
     WHERE conversation_id = ? ORDER BY id DESC LIMIT 10`
  )
    .bind(conversation.conversation_id)
    .all()
    .then((result) => (result.results || []).reverse());
  const incoming = [...history].reverse().find((message) => message.direcao === 'in')?.texto;
  if (!incoming) throw new HttpError(400, 'A conversa ainda não tem mensagem recebida', 'VALIDATION');
  const text = await generateWhatsAppReply(env, { config, history, incoming });
  const response = await sendText(env, {
    accountId: conversation.account_id || config.account_id,
    profileId: conversation.profile_id || config.profile_id,
    conversationId: providerConversationId(conversation),
    phone: conversation.contato,
    text,
  });
  await saveMessage(env, {
    conversationId: conversation.conversation_id,
    messageId: response.messageId,
    direction: 'out',
    origin: 'ia',
    text,
    status: response.ok ? 'enviado' : 'erro',
    author: user.email,
    payload: response.raw,
  });
  return { ok: response.ok, text, waMe: response.waMe, provider: response.raw };
}

export async function handleWaSync(req, env, ctx) {
  const user = await requireAuth(req, env, ['admin', 'gerente']);
  const config = await getWaConfig(env);
  if (!zernioConfigured(env)) {
    throw new HttpError(503, 'ZERNIO_API_KEY não configurada', 'ZERNIO_NOT_CONFIGURED');
  }
  const result = await listConversations(env, {
    accountId: config.account_id || env.ZERNIO_ACCOUNT_ID,
    limit: 100,
  });
  if (!result.ok) {
    throw new HttpError(502, 'Não foi possível listar conversas no Zernio', 'ZERNIO_SYNC_FAILED', result);
  }
  let synced = 0;
  for (const raw of result.conversations) {
    const conversation = normalizeConversation(raw);
    await upsertConversation(env, conversation, { unreadIncrement: 0 });
    synced += 1;
  }
  audit(env, ctx, {
    usuario: user.email,
    acao: 'whatsapp_sync',
    entidade: 'wa_conversas',
    detalhe: { synced },
  });
  return { ok: true, sincronizadas: synced };
}

export async function handleWaSendNew(req, env, ctx) {
  const user = await requireAuth(req, env);
  const body = await readJson(req);
  const phone = onlyDigits(body.phone || body.tel);
  const text = str(body.text || body.message, 4096);
  if (!phone || phone.length < 10) throw new HttpError(400, 'Telefone inválido', 'VALIDATION');
  if (!text) throw new HttpError(400, 'Mensagem vazia', 'VALIDATION');
  const config = await getWaConfig(env);
  let response;
  try {
    response = await sendText(env, {
      accountId: config.account_id,
      profileId: config.profile_id,
      phone,
      text,
    });
  } catch (error) {
    const waMe = `https://wa.me/${phoneForWa(phone)}?text=${encodeURIComponent(text)}`;
    return { ok: false, fallback: true, waMe, erro: error?.message || String(error) };
  }
  const conversationId = response.conversationId || syntheticConversationId(phone);
  const conversation = await upsertConversation(env, {
    conversationId,
    accountId: config.account_id,
    profileId: config.profile_id,
    contact: phone,
    name: str(body.nome, 120),
    lastMessage: text,
    lastAt: new Date().toISOString(),
  });
  await saveMessage(env, {
    conversationId,
    messageId: response.messageId,
    direction: 'out',
    origin: 'humano',
    text,
    status: response.ok ? 'enviado' : 'erro',
    author: user.email,
    payload: response.raw,
  });
  audit(env, ctx, { usuario: user.email, acao: 'whatsapp_envio_novo', entidade: 'wa_conversas', entidade_id: conversationId });
  return {
    ok: response.ok,
    fallback: !response.ok,
    waMe: response.waMe,
    conversationId,
    conversa: conversation,
    provider: response.raw,
  };
}

export async function handleLegacyWaSend(req, env, ctx) {
  let user = null;
  try {
    user = await requireAuth(req, env);
  } catch {
    user = null;
  }
  const body = await readJson(req);
  const phone = onlyDigits(body.phone || body.tel);
  const text = str(body.text || body.message, 4096);
  const waMe = phone
    ? `https://wa.me/${phoneForWa(phone)}?text=${encodeURIComponent(text || '')}`
    : null;
  if (!phone || phone.length < 10) {
    throw new HttpError(400, 'Telefone inválido (use DDI+DDD+número)', 'VALIDATION');
  }
  if (!text && !(body.useTemplate && body.templateName)) {
    throw new HttpError(400, 'Mensagem ou template obrigatório', 'VALIDATION');
  }
  if (!user) {
    return {
      ok: false,
      fallback: true,
      waMe,
      dica: 'Faça login para enviar pelo WhatsApp API. Sem sessão, use o link wa.me.',
    };
  }
  const config = await getWaConfig(env);
  try {
    await rateLimit(env, `wa-send:${user.email}`, 120, 3600);
    if (body.useTemplate && body.templateName) {
      const result = await sendTemplate(env, {
        accountId: config.account_id,
        profileId: config.profile_id,
        phone,
        templateName: body.templateName,
        language: body.language,
        params: body.params,
      });
      return { ok: result.ok, mode: 'template', detalhe: result.raw, waMe };
    }
    const result = await sendText(env, {
      accountId: config.account_id,
      profileId: config.profile_id,
      phone,
      text,
    });
    return { ok: result.ok, mode: 'text', messageId: result.messageId, detalhe: result.raw, waMe };
  } catch (error) {
    return { ok: false, fallback: true, waMe, erro: error?.message || String(error) };
  }
}

export async function handleLegacyBroadcast(req, env, ctx) {
  const user = await requireAuth(req, env, ['admin', 'gerente']);
  const body = await readJson(req);
  const phones = (Array.isArray(body.phones) ? body.phones : [])
    .map(onlyDigits)
    .filter((phone) => phone.length >= 10)
    .slice(0, 50);
  if (!phones.length) throw new HttpError(400, 'Lista de telefones vazia', 'VALIDATION');
  if (!body.templateName) throw new HttpError(400, 'templateName obrigatório', 'VALIDATION');
  await rateLimit(env, `wa-broadcast:${user.email}`, 10, 3600);
  const config = await getWaConfig(env);
  const results = [];
  for (let i = 0; i < phones.length; i += 5) {
    const batch = phones.slice(i, i + 5);
    const sent = await Promise.all(
      batch.map(async (phone) => {
        try {
          const result = await sendTemplate(env, {
            accountId: config.account_id,
            profileId: config.profile_id,
            phone,
            templateName: body.templateName,
            language: body.language,
            params: body.params,
          });
          return { phone, ok: result.ok };
        } catch (error) {
          return { phone, ok: false, erro: error?.message || String(error) };
        }
      })
    );
    results.push(...sent);
  }
  const enviados = results.filter((item) => item.ok).length;
  audit(env, ctx, {
    usuario: user.email,
    acao: 'whatsapp_broadcast',
    entidade: 'wa_mensagens',
    detalhe: { total: phones.length, enviados },
  });
  return { ok: enviados > 0, total: phones.length, enviados, resultados: results };
}

/* ============================================================
   WEBHOOK (SEM SESSÃO, COM ASSINATURA HMAC)
   ============================================================ */

export async function handleZernioWebhook(req, env, ctx) {
  const rawBody = await req.text();
  if (rawBody.length > 1024 * 1024) throw new HttpError(413, 'Webhook muito grande');
  const verification = await verifyWebhook(req, rawBody, env);
  if (!verification.ok) {
    throw new HttpError(401, 'Assinatura do webhook inválida', 'WEBHOOK_UNAUTHORIZED', {
      reason: verification.reason,
    });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'JSON inválido no webhook');
  }
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};
  const merged = {
    ...payload,
    ...data,
    event: payload.event || payload.type || data.event || data.type,
  };
  const event = parseWebhook(merged);
  const eventId =
    str(payload.id || payload.eventId || payload.event_id || data.id, 180) ||
    (await sha256Hex(rawBody));
  const db = dbRequired(env);
  const inserted = await db
    .prepare('INSERT OR IGNORE INTO wa_eventos (evento_id, tipo) VALUES (?, ?)')
    .bind(eventId, event.event || 'unknown')
    .run();
  if (!inserted.meta?.changes) {
    return { ok: true, duplicate: true, eventoId: eventId };
  }

  const eventType = String(event.event || '').toLowerCase();
  if (event.messageId) {
    if (/read/.test(eventType)) {
      await updateMessageStatus(env, event.messageId, 'lido');
      return { ok: true, evento: event.event, tipo: 'status' };
    }
    if (/delivered|sent/.test(eventType) && event.fromMe) {
      await updateMessageStatus(env, event.messageId, eventType.includes('delivered') ? 'entregue' : 'enviado');
      return { ok: true, evento: event.event, tipo: 'status' };
    }
  }

  const isMessageEvent = /message|mensagem/.test(eventType) || Boolean(event.text || event.messageId);
  if (!isMessageEvent) {
    return { ok: true, evento: event.event, tipo: 'ignorado' };
  }

  const phone = onlyDigits(event.contactPhone);
  const conversationId = str(event.conversationId, 160) || syntheticConversationId(phone);
  const config = await getWaConfig(env);
  const type = event.messageType || 'text';
  const text = event.text || (type === 'text' ? '' : messagePlaceholder(type));
  const conversation = await upsertConversation(
    env,
    {
      conversationId,
      accountId: event.accountId || config.account_id,
      profileId: event.profileId || config.profile_id,
      contact: phone || event.contactPhone,
      name: event.contactName,
      lastMessage: text,
      lastAt: event.timestamp || new Date().toISOString(),
    },
    { unreadIncrement: event.fromMe ? 0 : 1 }
  );
  await saveMessage(env, {
    conversationId,
    messageId: event.messageId,
    direction: event.fromMe ? 'out' : 'in',
    origin: event.fromMe ? 'zernio' : 'contato',
    text,
    type,
    status: event.fromMe ? 'enviado' : 'recebido',
    author: event.contactName || phone || null,
    payload,
  });

  if (event.fromMe) {
    return { ok: true, evento: event.event, tipo: 'enviado', conversationId };
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(
      autoReply(env, conversation, { ...event, text }, config).catch((error) => {
        console.error('Auto-resposta WhatsApp falhou:', error?.stack || error);
      })
    );
  } else {
    await autoReply(env, conversation, { ...event, text }, config).catch(() => {});
  }
  return { ok: true, evento: event.event, tipo: 'recebido', conversationId };
}
