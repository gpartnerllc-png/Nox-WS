-- Perfil documental e histórico de acessos dos usuários.
-- Idempotente: pode ser aplicado depois do schema.sql sem conflito.

CREATE TABLE IF NOT EXISTS usuarios_perfil (
  usuario_email TEXT PRIMARY KEY COLLATE NOCASE,
  doc TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'CPF',
  ultimo_acesso TEXT,
  ultimo_ip TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_perfil_doc ON usuarios_perfil(doc);

CREATE TABLE IF NOT EXISTS acessos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_email TEXT NOT NULL,
  usuario_doc TEXT,
  evento TEXT NOT NULL DEFAULT 'login',
  ip TEXT,
  user_agent TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acessos_email ON acessos(usuario_email, id);
CREATE INDEX IF NOT EXISTS idx_acessos_doc ON acessos(usuario_doc);
CREATE INDEX IF NOT EXISTS idx_acessos_data ON acessos(criado_em);
