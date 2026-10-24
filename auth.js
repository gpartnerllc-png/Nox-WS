import {
  HttpError,
  clientIp,
  escapeLike,
  isValidEmail,
  json,
  onlyDigits,
  readJson,
  str,
  isAdmin,
} from './http.js';
import {
  hashPassword,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from './security.js';

const SESSION_DAYS = 30;

function cpfCheckDigit(base, factor) {
  let sum = 0;
  for (const digit of base) {
    sum += Number(digit) * factor;
    factor -= 1;
  }
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

function cnpjCheckDigit(base, weights) {
  const sum = weights.reduce((total, weight, index) => total + Number(base[index]) * weight, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCpf(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const first = cpfCheckDigit(digits.slice(0, 9), 10);
  const second = cpfCheckDigit(digits.slice(0, 10), 11);
  return digits[9] === String(first) && digits[10] === String(second);
}

export function isValidCnpj(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const first = cnpjCheckDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = cnpjCheckDigit(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return digits[12] === String(first) && digits[13] === String(second);
}

export function normalizeDocumento(value) {
  const digits = onlyDigits(value);
  if (digits.length === 11 && isValidCpf(digits)) return { doc: digits, tipo: 'CPF' };
  if (digits.length === 14 && isValidCnpj(digits)) return { doc: digits, tipo: 'CNPJ' };
  return null;
}

export function maskDocumento(value) {
  const digits = onlyDigits(value);
  if (digits.length === 11) return `***.***.***-${digits.slice(-2)}`;
  if (digits.length === 14) return `**.***.***/****-${digits.slice(-2)}`;
  return '';
}

function dbRequired(env) {
  if (!env.DB) {
    throw new HttpError(
      503,
      'Banco D1 não conectado. Rode as migrações e confira o binding DB.',
      'DB_REQUIRED'
    );
  }
  return env.DB;
}

export async function rateLimit(env, key, limit, windowSeconds) {
  if (!env.DB) return { ok: true, count: 1, limit, remaining: limit };
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  try {
    const [, selected] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_limits (chave, janela, contador) VALUES (?, ?, 1)
         ON CONFLICT(chave, janela) DO UPDATE SET contador = contador + 1`
      ).bind(key, bucket),
      env.DB.prepare(
        'SELECT contador FROM rate_limits WHERE chave = ? AND janela = ?'
      ).bind(key, bucket),
    ]);
    const count = Number(selected?.results?.[0]?.contador || 1);
    return { ok: count <= limit, count, limit, remaining: Math.max(0, limit - count) };
  } catch (error) {
    console.error('Rate limit D1 falhou:', error?.message || error);
    return { ok: true, count: 1, limit, remaining: limit };
  }
}

export async function enforceRateLimit(env, key, limit, windowSeconds) {
  const result = await rateLimit(env, key, limit, windowSeconds);
  if (!result.ok) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'RATE_LIMITED', {
      retryAfter: windowSeconds,
    });
  }
  return result;
}

export function audit(env, ctx, entry) {
  if (!env.DB) return;
  const user = str(entry.usuario, 180) || null;
  const action = str(entry.acao, 120);
  if (!action) return;
  const statement = env.DB.prepare(
    `INSERT INTO auditoria (usuario, acao, entidade, entidade_id, ip, detalhe)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    user,
    action,
    str(entry.entidade, 80) || null,
    str(entry.entidade_id, 120) || null,
    str(entry.ip, 64) || null,
    entry.detalhe ? JSON.stringify(entry.detalhe).slice(0, 4000) : null
  );
  const promise = statement.run().catch((error) => {
    console.error('Auditoria falhou:', error?.message || error);
  });
  if (ctx?.waitUntil) ctx.waitUntil(promise);
  else promise.catch(() => {});
}

export async function createSession(env, user, req) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const db = dbRequired(env);
  await db
    .prepare(
      `INSERT INTO sessoes (token_hash, usuario_email, expira_em, ip, user_agent, ultimo_uso)
       VALUES (?, ?, datetime('now', ?), ?, ?, datetime('now'))`
    )
    .bind(
      tokenHash,
      user.email,
      `+${SESSION_DAYS} days`,
      clientIp(req),
      str(req.headers.get('User-Agent'), 300)
    )
    .run();
  return {
    token,
    expiraEm: new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString(),
  };
}

export async function requireAuth(req, env, roles = null) {
  const apiKey = req.headers.get('X-API-Key') || '';
  if (env.API_KEY && apiKey && timingSafeEqual(apiKey, env.API_KEY)) {
    const user = { email: 'api@internal', nome: 'Integração', papel: 'admin', via: 'api-key' };
    if (roles && !roles.includes(user.papel)) throw new HttpError(403, 'Acesso negado');
    return user;
  }

  const header = req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Faça login para continuar', 'UNAUTHORIZED');

  const db = dbRequired(env);
  let row;
  try {
    row = await db
      .prepare(
        `SELECT u.email, u.nome, u.papel, u.status, s.token_hash,
                p.doc, p.tipo, p.ultimo_acesso
         FROM sessoes s
         JOIN usuarios u ON u.email = s.usuario_email
         LEFT JOIN usuarios_perfil p ON LOWER(p.usuario_email) = LOWER(u.email)
         WHERE s.token_hash = ?
           AND s.expira_em > datetime('now')
           AND u.status = 'ativo'`
      )
      .bind(await sha256Hex(token))
      .first();
  } catch (error) {
    console.error('Falha ao validar sessão:', error?.message || error);
    throw new HttpError(503, 'Banco indisponível. Tente novamente.', 'DB_UNAVAILABLE');
  }
  if (!row) throw new HttpError(401, 'Sessão expirada. Entre novamente.', 'SESSION_EXPIRED');
  const user = {
    email: row.email,
    nome: row.nome,
    papel: row.papel,
    doc: row.doc || null,
    tipo: row.tipo || null,
    ultimo_acesso: row.ultimo_acesso || null,
  };
  if (roles && !roles.includes(user.papel) && user.email !== 'api@internal') {
    throw new HttpError(403, 'Sem permissão para esta ação', 'FORBIDDEN');
  }
  return user;
}

export async function optionalAuth(req, env) {
  try {
    return await requireAuth(req, env);
  } catch {
    return null;
  }
}

const USER_SELECT = `u.id, u.email, u.senha_hash, u.nome, u.papel, u.status,
                     p.doc, p.tipo, p.ultimo_acesso`;

async function findUserByEmail(env, email) {
  return dbRequired(env)
    .prepare(
      `SELECT ${USER_SELECT}
       FROM usuarios u
       LEFT JOIN usuarios_perfil p ON LOWER(p.usuario_email) = LOWER(u.email)
       WHERE LOWER(u.email) = LOWER(?) LIMIT 1`
    )
    .bind(email)
    .first();
}

async function findUserByDoc(env, doc) {
  return dbRequired(env)
    .prepare(
      `SELECT ${USER_SELECT}
       FROM usuarios u
       JOIN usuarios_perfil p ON LOWER(p.usuario_email) = LOWER(u.email)
       WHERE p.doc = ? LIMIT 1`
    )
    .bind(doc)
    .first();
}

async function recordAccess(env, user, req, evento = 'login') {
  if (!env.DB) return;
  const ip = clientIp(req);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE usuarios_perfil
         SET ultimo_acesso = datetime('now'), ultimo_ip = ?, atualizado_em = datetime('now')
         WHERE LOWER(usuario_email) = LOWER(?)`
      ).bind(ip, user.email),
      env.DB.prepare(
        `INSERT INTO acessos (usuario_email, usuario_doc, evento, ip, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(user.email, user.doc || null, evento, ip, str(req.headers.get('User-Agent'), 300)),
    ]);
  } catch (error) {
    console.error('Registro de acesso falhou:', error?.message || error);
  }
}

export async function handleLogin(req, env, ctx) {
  const body = await readJson(req);
  const identifier = str(
    body.identificador ?? body.identifier ?? body.email ?? body.doc ?? body.documento,
    180
  );
  const senha = String(body.senha ?? body.password ?? '');
  if (!identifier || !senha) {
    throw new HttpError(400, 'Informe e-mail ou CPF/CNPJ e senha', 'VALIDATION');
  }
  const isEmail = identifier.includes('@');
  let documento = null;
  if (isEmail) {
    if (!isValidEmail(identifier)) {
      throw new HttpError(400, 'E-mail inválido', 'VALIDATION');
    }
  } else {
    documento = normalizeDocumento(identifier);
    if (!documento) {
      throw new HttpError(400, 'Informe um CPF/CNPJ válido ou um e-mail', 'INVALID_DOCUMENT');
    }
  }
  const lookupKey = isEmail ? identifier.toLowerCase() : documento.doc;
  const ip = clientIp(req);
  await enforceRateLimit(env, `login:ip:${ip}`, 30, 900);
  await enforceRateLimit(env, `login:${ip}:${lookupKey}`, 10, 900);

  const db = dbRequired(env);
  let user;
  try {
    user = isEmail ? await findUserByEmail(env, identifier) : await findUserByDoc(env, documento.doc);
  } catch (error) {
    throw new HttpError(503, 'Banco indisponível. Tente novamente.', 'DB_UNAVAILABLE');
  }
  const verification = user
    ? await verifyPassword(senha, user.senha_hash)
    : { ok: false };
  if (!user || !verification.ok) {
    audit(env, ctx, {
      usuario: isEmail ? identifier.toLowerCase() : maskDocumento(identifier),
      acao: 'login_falhou',
      ip,
    });
    throw new HttpError(401, 'E-mail/CPF/CNPJ ou senha incorretos', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'pendente') {
    throw new HttpError(403, 'Cadastro aguardando aprovação do administrador', 'PENDING');
  }
  if (user.status !== 'ativo') {
    throw new HttpError(403, 'Usuário bloqueado. Fale com o administrador.', 'BLOCKED');
  }

  if (verification.legacy || verification.needsRehash) {
    try {
      const upgraded = await hashPassword(senha);
      await db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').bind(upgraded, user.id).run();
    } catch (error) {
      console.error('Falha ao atualizar hash de senha:', error?.message || error);
    }
  }

  const session = await createSession(env, user, req);
  await recordAccess(env, user, req);
  audit(env, ctx, { usuario: user.email, acao: 'login', ip });
  return {
    ok: true,
    token: session.token,
    expiraEm: session.expiraEm,
    usuario: {
      email: user.email,
      nome: user.nome,
      papel: user.papel,
      doc: user.doc || null,
      tipo: user.tipo || null,
    },
  };
}

export async function handleRegister(req, env, ctx) {
  const body = await readJson(req);
  const nome = str(body.nome, 120);
  const email = str(body.email, 180).toLowerCase();
  const senha = String(body.senha ?? body.password ?? '');
  const documento = normalizeDocumento(body.doc ?? body.documento ?? body.cpfCnpj);
  if (!nome || !isValidEmail(email)) {
    throw new HttpError(400, 'Nome e e-mail válidos são obrigatórios', 'VALIDATION');
  }
  if (!documento) {
    throw new HttpError(400, 'Informe um CPF ou CNPJ válido', 'INVALID_DOCUMENT');
  }
  if (senha.length < 8) {
    throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres', 'WEAK_PASSWORD');
  }
  const ip = clientIp(req);
  await enforceRateLimit(env, `register:${ip}`, 6, 3600);
  const db = dbRequired(env);
  const existingEmail = await db
    .prepare('SELECT id FROM usuarios WHERE LOWER(email) = LOWER(?) LIMIT 1')
    .bind(email)
    .first();
  if (existingEmail) {
    throw new HttpError(409, 'Este e-mail já está cadastrado', 'EMAIL_EXISTS');
  }
  const existingDoc = await db
    .prepare('SELECT usuario_email FROM usuarios_perfil WHERE doc = ? LIMIT 1')
    .bind(documento.doc)
    .first();
  if (existingDoc) {
    throw new HttpError(409, 'Este CPF/CNPJ já está cadastrado', 'DOC_EXISTS');
  }
  const hash = await hashPassword(senha);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO usuarios (email, senha_hash, nome, papel, status)
         VALUES (?, ?, ?, 'operador', 'pendente')`
      ).bind(email, hash, nome),
      db.prepare(
        'INSERT INTO usuarios_perfil (usuario_email, doc, tipo) VALUES (?, ?, ?)'
      ).bind(email, documento.doc, documento.tipo),
    ]);
  } catch (error) {
    const message = String(error?.message || error);
    if (/usuarios_perfil|idx_usuarios_perfil_doc/i.test(message)) {
      throw new HttpError(409, 'Este CPF/CNPJ já está cadastrado', 'DOC_EXISTS');
    }
    if (/usuarios|email/i.test(message)) {
      throw new HttpError(409, 'Este e-mail já está cadastrado', 'EMAIL_EXISTS');
    }
    throw error;
  }
  audit(env, ctx, {
    usuario: email,
    acao: 'cadastro_solicitado',
    entidade: 'usuarios',
    detalhe: { documento: documento.tipo },
    ip,
  });
  return { ok: true, msg: 'Cadastro enviado. Aguarde a aprovação do administrador.' };
}

async function sendResetEmail(env, { to, nome, resetUrl }) {
  if (!env.RESEND_API_KEY || !env.RESET_FROM) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESET_FROM,
      to: [to],
      subject: 'Redefinição de senha · NoxMob',
      html: `<p>Olá, ${nome || 'tudo bem'}.</p><p>Recebemos um pedido para redefinir sua senha.</p><p><a href="${resetUrl}">Criar nova senha</a></p><p>O link expira em 1 hora. Se não foi você, ignore este e-mail.</p>`,
    }),
  });
  return response.ok;
}

export async function handleForgot(req, env, ctx) {
  const body = await readJson(req);
  const email = str(body.email, 180).toLowerCase();
  if (!isValidEmail(email)) throw new HttpError(400, 'E-mail inválido', 'VALIDATION');
  const ip = clientIp(req);
  await enforceRateLimit(env, `forgot:${ip}`, 6, 3600);
  const db = dbRequired(env);
  const user = await findUserByEmail(env, email);
  const generic = {
    ok: true,
    msg: 'Se este e-mail existir, enviaremos as instruções de recuperação.',
  };
  if (!user) return generic;

  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const expira = new Date(Date.now() + 3600e3).toISOString();
  await db
    .prepare('INSERT OR REPLACE INTO reset_senha (email, token, expira) VALUES (?, ?, ?)')
    .bind(email, tokenHash, expira)
    .run();

  const appUrl = (env.APP_URL || String(env.ALLOWED_ORIGIN || '').split(',')[0] || 'https://ws.droppfy.com').replace(/\/$/, '');
  const resetUrl = `${appUrl}/?reset=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`;
  let sent = false;
  try {
    sent = await sendResetEmail(env, { to: email, nome: user.nome, resetUrl });
  } catch (error) {
    console.error('Envio de reset falhou:', error?.message || error);
  }
  audit(env, ctx, { usuario: email, acao: 'recuperacao_senha', ip, detalhe: { sent } });
  if (env.EXPOSE_RESET_TOKEN === 'true') {
    return { ...generic, tokenDev: rawToken, resetUrl };
  }
  if (!sent) {
    console.warn('Reset gerado, mas nenhum provedor de e-mail está configurado.');
  }
  return generic;
}

export async function handleReset(req, env, ctx) {
  const body = await readJson(req);
  const email = str(body.email, 180).toLowerCase();
  const token = str(body.token, 300);
  const novaSenha = String(body.senha ?? body.password ?? '');
  if (!isValidEmail(email) || !token) throw new HttpError(400, 'Token inválido', 'VALIDATION');
  await enforceRateLimit(env, `reset:${clientIp(req)}`, 12, 3600);
  const db = dbRequired(env);
  const row = await db
    .prepare('SELECT email, token, expira FROM reset_senha WHERE email = ?')
    .bind(email)
    .first();
  const tokenHash = await sha256Hex(token);
  if (!row || !timingSafeEqual(row.token, tokenHash) || Date.parse(row.expira) < Date.now()) {
    throw new HttpError(400, 'Token inválido ou expirado. Solicite outro.', 'INVALID_RESET_TOKEN');
  }
  const hash = await hashPassword(novaSenha);
  await db.prepare('UPDATE usuarios SET senha_hash = ? WHERE LOWER(email) = LOWER(?)').bind(hash, email).run();
  await db.prepare('DELETE FROM reset_senha WHERE email = ?').bind(email).run();
  await db.prepare('DELETE FROM sessoes WHERE LOWER(usuario_email) = LOWER(?)').bind(email).run();
  audit(env, ctx, { usuario: email, acao: 'senha_redefinida', ip: clientIp(req) });
  return { ok: true, msg: 'Senha atualizada. Faça login novamente.' };
}

export async function handleMe(req, env) {
  const user = await requireAuth(req, env);
  return { ok: true, usuario: user };
}

export async function handleLogout(req, env, ctx) {
  const header = req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token && env.DB) {
    await env.DB.prepare('DELETE FROM sessoes WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  }
  audit(env, ctx, { usuario: 'sessão', acao: 'logout', ip: clientIp(req) });
  return { ok: true };
}

export async function handleChangePassword(req, env, ctx) {
  const user = await requireAuth(req, env);
  const body = await readJson(req);
  const atual = String(body.atual ?? body.currentPassword ?? '');
  const nova = String(body.nova ?? body.password ?? '');
  const db = dbRequired(env);
  const row = await findUserByEmail(env, user.email);
  if (!row || !(await verifyPassword(atual, row.senha_hash)).ok) {
    throw new HttpError(401, 'Senha atual incorreta', 'INVALID_PASSWORD');
  }
  await db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?')
    .bind(await hashPassword(nova), row.id)
    .run();
  await db.prepare('DELETE FROM sessoes WHERE LOWER(usuario_email) = LOWER(?)')
    .bind(user.email)
    .run();
  audit(env, ctx, { usuario: user.email, acao: 'senha_alterada', ip: clientIp(req) });
  return { ok: true, msg: 'Senha alterada. Entre novamente.' };
}

export async function handleBootstrap(req, env, ctx) {
  const db = dbRequired(env);
  if (!env.BOOTSTRAP_TOKEN) {
    throw new HttpError(501, 'Configure o secret BOOTSTRAP_TOKEN para criar o primeiro admin', 'BOOTSTRAP_DISABLED');
  }
  const received = req.headers.get('X-Bootstrap-Token') || '';
  if (!timingSafeEqual(received, env.BOOTSTRAP_TOKEN)) {
    throw new HttpError(401, 'Token de bootstrap inválido', 'INVALID_BOOTSTRAP_TOKEN');
  }
  const count = await db.prepare('SELECT COUNT(*) AS total FROM usuarios').first();
  if (Number(count?.total || 0) > 0) {
    throw new HttpError(409, 'Já existem usuários. Use o login normal.', 'ALREADY_INITIALIZED');
  }
  const body = await readJson(req);
  const nome = str(body.nome, 120) || 'Administrador';
  const email = str(body.email, 180).toLowerCase();
  const senha = String(body.senha ?? body.password ?? '');
  const documentoRaw = body.doc ?? body.documento ?? body.cpfCnpj;
  if (!isValidEmail(email)) throw new HttpError(400, 'E-mail inválido', 'VALIDATION');
  if (senha.length < 8) {
    throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres', 'WEAK_PASSWORD');
  }
  const documento = documentoRaw ? normalizeDocumento(documentoRaw) : null;
  if (documentoRaw && !documento) {
    throw new HttpError(400, 'CPF/CNPJ inválido', 'INVALID_DOCUMENT');
  }
  const statements = [
    db.prepare(
      `INSERT INTO usuarios (email, senha_hash, nome, papel, status)
       VALUES (?, ?, ?, 'admin', 'ativo')`
    ).bind(email, await hashPassword(senha), nome),
  ];
  if (documento) {
    statements.push(
      db.prepare(
        'INSERT INTO usuarios_perfil (usuario_email, doc, tipo) VALUES (?, ?, ?)'
      ).bind(email, documento.doc, documento.tipo)
    );
  }
  await db.batch(statements);
  audit(env, ctx, { usuario: email, acao: 'bootstrap_admin', ip: clientIp(req) });
  return { ok: true, msg: 'Administrador criado. Faça login.' };
}

export async function handleApprove(req, env, ctx) {
  const admin = await requireAuth(req, env, ['admin']);
  const body = await readJson(req);
  const email = str(body.email || body.emailAlvo, 180).toLowerCase();
  if (!email) throw new HttpError(400, 'Informe o e-mail', 'VALIDATION');
  const db = dbRequired(env);
  const result = await db.prepare("UPDATE usuarios SET status = 'ativo' WHERE LOWER(email) = LOWER(?)").bind(email).run();
  if (!result.meta?.changes) throw new HttpError(404, 'Usuário não encontrado', 'NOT_FOUND');
  audit(env, ctx, { usuario: admin.email, acao: 'usuario_aprovado', entidade: 'usuarios', entidade_id: email, ip: clientIp(req) });
  return { ok: true };
}

export async function handleListUsers(req, env) {
  await requireAuth(req, env, ['admin']);
  const { results } = await dbRequired(env)
    .prepare(
      `SELECT u.id, u.email, u.nome, u.papel, u.status, u.criado_em,
              p.doc, p.tipo, p.ultimo_acesso, p.ultimo_ip,
              (SELECT COUNT(*) FROM sessoes s
                WHERE LOWER(s.usuario_email) = LOWER(u.email)
                  AND s.expira_em > datetime('now')) AS sessoes_ativas
       FROM usuarios u
       LEFT JOIN usuarios_perfil p ON LOWER(p.usuario_email) = LOWER(u.email)
       ORDER BY u.id DESC`
    )
    .all();
  return { ok: true, usuarios: results || [] };
}

export async function handleSetUserDoc(req, env, ctx) {
  const admin = await requireAuth(req, env, ['admin']);
  const body = await readJson(req);
  const email = str(body.email || body.emailAlvo, 180).toLowerCase();
  if (!email) throw new HttpError(400, 'Informe o e-mail do usuário', 'VALIDATION');
  const documento = normalizeDocumento(body.doc ?? body.documento ?? body.cpfCnpj);
  if (!documento) throw new HttpError(400, 'Informe um CPF ou CNPJ válido', 'INVALID_DOCUMENT');
  const db = dbRequired(env);
  const target = await db
    .prepare('SELECT email FROM usuarios WHERE LOWER(email) = LOWER(?) LIMIT 1')
    .bind(email)
    .first();
  if (!target) throw new HttpError(404, 'Usuário não encontrado', 'NOT_FOUND');
  const owner = await db
    .prepare(
      'SELECT usuario_email FROM usuarios_perfil WHERE doc = ? AND LOWER(usuario_email) <> LOWER(?) LIMIT 1'
    )
    .bind(documento.doc, email)
    .first();
  if (owner) {
    throw new HttpError(409, 'Este CPF/CNPJ já está vinculado a outro usuário', 'DOC_EXISTS');
  }
  try {
    await db
      .prepare(
        `INSERT INTO usuarios_perfil (usuario_email, doc, tipo, atualizado_em)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(usuario_email) DO UPDATE SET
           doc = excluded.doc,
           tipo = excluded.tipo,
           atualizado_em = datetime('now')`
      )
      .bind(target.email, documento.doc, documento.tipo)
      .run();
  } catch (error) {
    if (/UNIQUE|usuarios_perfil/i.test(String(error?.message || error))) {
      throw new HttpError(409, 'Este CPF/CNPJ já está vinculado a outro usuário', 'DOC_EXISTS');
    }
    throw error;
  }
  audit(env, ctx, {
    usuario: admin.email,
    acao: 'documento_vinculado',
    entidade: 'usuarios',
    entidade_id: target.email,
    detalhe: { tipo: documento.tipo, doc: maskDocumento(documento.doc) },
    ip: clientIp(req),
  });
  return { ok: true, usuario: { email: target.email, doc: documento.doc, tipo: documento.tipo } };
}

export async function handleTrackUser(req, env, ctx) {
  const admin = await requireAuth(req, env, ['admin']);
  const url = new URL(req.url);
  const term = str(url.searchParams.get('q') || url.searchParams.get('doc') || '', 120);
  if (term.length < 2) {
    throw new HttpError(400, 'Informe CPF, CNPJ, e-mail ou nome para consultar', 'VALIDATION');
  }
  const digits = onlyDigits(term);
  const numeric = /^[\d.\-/\s]+$/.test(term) && digits.length >= 3;
  const documento = normalizeDocumento(term);
  const exactDoc = documento?.doc || null;
  const likeTerm = `%${escapeLike(term)}%`;
  const likeDoc = `%${escapeLike(digits)}%`;
  const db = dbRequired(env);

  const userWhere = exactDoc
    ? { sql: 'p.doc = ?', params: [exactDoc] }
    : numeric
      ? {
          sql: "(p.doc LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE LOWER(?) OR LOWER(u.nome) LIKE LOWER(?))",
          params: [likeDoc, likeTerm, likeTerm],
        }
      : {
          sql: '(LOWER(u.email) LIKE LOWER(?) OR LOWER(u.nome) LIKE LOWER(?))',
          params: [likeTerm, likeTerm],
        };

  const peopleWhere = exactDoc
    ? { sql: 'doc = ?', params: [exactDoc] }
    : numeric
      ? {
          sql: "(doc LIKE ? ESCAPE '\\' OR LOWER(nome) LIKE LOWER(?) OR tel LIKE ? ESCAPE '\\')",
          params: [likeDoc, likeTerm, likeDoc],
        }
      : {
          sql: '(LOWER(nome) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?))',
          params: [likeTerm, likeTerm],
        };

  const leadWhere = exactDoc
    ? { sql: 'doc = ?', params: [exactDoc] }
    : numeric
      ? {
          sql: "(doc LIKE ? ESCAPE '\\' OR LOWER(nome) LIKE LOWER(?) OR tel LIKE ? ESCAPE '\\')",
          params: [likeDoc, likeTerm, likeDoc],
        }
      : { sql: 'LOWER(nome) LIKE LOWER(?)', params: [likeTerm] };

  const statements = [
    db
      .prepare(
        `SELECT u.id, u.email, u.nome, u.papel, u.status, u.criado_em,
                p.doc, p.tipo, p.ultimo_acesso, p.ultimo_ip,
                (SELECT COUNT(*) FROM sessoes s
                  WHERE LOWER(s.usuario_email) = LOWER(u.email)
                    AND s.expira_em > datetime('now')) AS sessoes_ativas
         FROM usuarios u
         LEFT JOIN usuarios_perfil p ON LOWER(p.usuario_email) = LOWER(u.email)
         WHERE ${userWhere.sql}
         ORDER BY u.id DESC LIMIT 25`
      )
      .bind(...userWhere.params),
    db
      .prepare(
        `SELECT id, nome, doc, tipo, tel, email, criado_em
         FROM pessoas WHERE ${peopleWhere.sql}
         ORDER BY id DESC LIMIT 25`
      )
      .bind(...peopleWhere.params),
    db
      .prepare(
        `SELECT id, nome, tel, doc, compras, ultima_compra, valor, criado_em
         FROM leads WHERE ${leadWhere.sql}
         ORDER BY id DESC LIMIT 25`
      )
      .bind(...leadWhere.params),
    exactDoc
      ? db
          .prepare(
            `SELECT id, provider, metodo, status, valor, descricao, cliente_nome, cliente_doc, criado_em
             FROM pagamentos WHERE cliente_doc = ? ORDER BY id DESC LIMIT 25`
          )
          .bind(exactDoc)
      : numeric
        ? db
            .prepare(
              `SELECT id, provider, metodo, status, valor, descricao, cliente_nome, cliente_doc, criado_em
               FROM pagamentos WHERE cliente_doc LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 25`
            )
            .bind(likeDoc)
        : db.prepare('SELECT * FROM pagamentos WHERE 0'),
  ];

  const [usersRes, peopleRes, leadsRes, paymentsRes] = await db.batch(statements);
  const usuarios = usersRes.results || [];
  const pessoas = peopleRes.results || [];
  const leads = leadsRes.results || [];
  const pagamentos = paymentsRes.results || [];
  const emails = usuarios.map((item) => String(item.email).toLowerCase());

  let sessoes = [];
  let acessos = [];
  let auditoria = [];
  if (emails.length) {
    const marks = emails.map(() => '?').join(',');
    const [sessionsRes, accessRes, auditRes] = await db.batch([
      db
        .prepare(
          `SELECT usuario_email, criado_em, expira_em, ip, user_agent, ultimo_uso,
                  CASE WHEN expira_em > datetime('now') THEN 1 ELSE 0 END AS ativa
           FROM sessoes WHERE LOWER(usuario_email) IN (${marks})
           ORDER BY criado_em DESC LIMIT 60`
        )
        .bind(...emails),
      db
        .prepare(
          `SELECT usuario_email, usuario_doc, evento, ip, user_agent, criado_em
           FROM acessos WHERE LOWER(usuario_email) IN (${marks})
           ORDER BY id DESC LIMIT 120`
        )
        .bind(...emails),
      db
        .prepare(
          `SELECT id, usuario, acao, entidade, entidade_id, ip, detalhe, criado_em
           FROM auditoria
           WHERE LOWER(usuario) IN (${marks}) OR LOWER(entidade_id) IN (${marks})
           ORDER BY id DESC LIMIT 80`
        )
        .bind(...emails, ...emails),
    ]);
    sessoes = sessionsRes.results || [];
    acessos = accessRes.results || [];
    auditoria = auditRes.results || [];
  }

  const tipo = documento?.tipo || (numeric ? 'DOCUMENTO' : term.includes('@') ? 'E-MAIL' : 'NOME');
  audit(env, ctx, {
    usuario: admin.email,
    acao: 'consulta_cadastro',
    entidade: 'usuarios',
    entidade_id: maskDocumento(term) || str(term, 80),
    detalhe: {
      tipo,
      usuarios: usuarios.length,
      pessoas: pessoas.length,
      leads: leads.length,
    },
    ip: clientIp(req),
  });

  return {
    ok: true,
    consulta: {
      termo: maskDocumento(term) || term,
      tipo,
      usuarios: usuarios.length,
      sessoes: sessoes.length,
      acessos: acessos.length,
    },
    usuarios,
    sessoes,
    acessos,
    pessoas,
    leads,
    pagamentos,
    auditoria,
  };
}

export async function handleSetRole(req, env, ctx) {
  const admin = await requireAuth(req, env, ['admin']);
  const body = await readJson(req);
  const email = str(body.email, 180).toLowerCase();
  const papel = str(body.papel, 20);
  if (!email || !['admin', 'gerente', 'operador'].includes(papel)) {
    throw new HttpError(400, 'Papel inválido', 'VALIDATION');
  }
  if (email === admin.email && papel !== 'admin') {
    throw new HttpError(400, 'Você não pode remover seu próprio acesso de admin', 'SELF_ROLE');
  }
  const result = await dbRequired(env)
    .prepare('UPDATE usuarios SET papel = ? WHERE LOWER(email) = LOWER(?)')
    .bind(papel, email)
    .run();
  if (!result.meta?.changes) throw new HttpError(404, 'Usuário não encontrado', 'NOT_FOUND');
  audit(env, ctx, { usuario: admin.email, acao: 'papel_alterado', entidade: 'usuarios', entidade_id: email, detalhe: { papel } });
  return { ok: true };
}

export async function handleDeleteUser(req, env, ctx) {
  const admin = await requireAuth(req, env, ['admin']);
  const body = await readJson(req);
  const email = str(body.email, 180).toLowerCase();
  if (!email) throw new HttpError(400, 'Informe o e-mail', 'VALIDATION');
  if (email === admin.email) throw new HttpError(400, 'Você não pode excluir sua própria conta', 'SELF_DELETE');
  const db = dbRequired(env);
  await db.batch([
    db.prepare('DELETE FROM sessoes WHERE LOWER(usuario_email) = LOWER(?)').bind(email),
    db.prepare('DELETE FROM usuarios_perfil WHERE LOWER(usuario_email) = LOWER(?)').bind(email),
    db.prepare('DELETE FROM acessos WHERE LOWER(usuario_email) = LOWER(?)').bind(email),
    db.prepare('DELETE FROM usuarios WHERE LOWER(email) = LOWER(?)').bind(email),
  ]);
  audit(env, ctx, { usuario: admin.email, acao: 'usuario_excluido', entidade: 'usuarios', entidade_id: email, ip: clientIp(req) });
  return { ok: true };
}

export async function handleAudit(req, env) {
  await requireAuth(req, env, ['admin']);
  const { results } = await dbRequired(env)
    .prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT 150')
    .all();
  return { ok: true, eventos: results || [] };
}

export async function cleanupAuth(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessoes WHERE datetime(expira_em) <= datetime('now')"),
    env.DB.prepare("DELETE FROM reset_senha WHERE datetime(expira) <= datetime('now')"),
    env.DB.prepare("DELETE FROM rate_limits WHERE criado_em < datetime('now', '-2 days')"),
    env.DB.prepare("DELETE FROM wa_eventos WHERE recebido_em < datetime('now', '-30 days')"),
    env.DB.prepare("DELETE FROM acessos WHERE criado_em < datetime('now', '-365 days')"),
    env.DB.prepare("DELETE FROM auditoria WHERE criado_em < datetime('now', '-180 days')"),
  ]).catch((error) => console.error('Limpeza falhou:', error?.message || error));
}

export { isAdmin, onlyDigits, json };
