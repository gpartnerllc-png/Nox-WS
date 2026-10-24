-- NoxMob Cloud: tabelas novas, sem alterar tabelas existentes.
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_email TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now')),
  expira_em TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  ultimo_uso TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_email);
CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes(expira_em);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT,
  acao TEXT NOT NULL,
  entidade TEXT,
  entidade_id TEXT,
  ip TEXT,
  detalhe TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auditoria_criado ON auditoria(criado_em);

CREATE TABLE IF NOT EXISTS rate_limits (
  chave TEXT NOT NULL,
  janela INTEGER NOT NULL,
  contador INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chave, janela)
);

CREATE TABLE IF NOT EXISTS sync_receipts (
  client_id TEXT PRIMARY KEY,
  venda_id INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  metodo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  valor REAL NOT NULL DEFAULT 0,
  descricao TEXT,
  cliente_nome TEXT,
  cliente_doc TEXT,
  external_id TEXT,
  txid TEXT,
  checkout_url TEXT,
  qr_payload TEXT,
  qr_image TEXT,
  expira_em TEXT,
  venda_id INTEGER,
  criado_por TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now')),
  pago_em TEXT,
  payload_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pag_external ON pagamentos(provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pag_criado ON pagamentos(criado_em);
CREATE INDEX IF NOT EXISTS idx_pag_status ON pagamentos(status);

CREATE TABLE IF NOT EXISTS wa_conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT UNIQUE NOT NULL,
  account_id TEXT,
  profile_id TEXT,
  contato TEXT,
  nome TEXT,
  canal TEXT DEFAULT 'whatsapp',
  ultima_mensagem TEXT,
  ultima_em TEXT,
  nao_lidas INTEGER DEFAULT 0,
  ia_ativa INTEGER DEFAULT 1,
  ia_pausada_ate TEXT,
  arquivada INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_conversas_ultima ON wa_conversas(ultima_em);

CREATE TABLE IF NOT EXISTS wa_mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  direcao TEXT NOT NULL,
  origem TEXT,
  texto TEXT,
  tipo TEXT DEFAULT 'text',
  status TEXT DEFAULT 'recebido',
  autor TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_conversa ON wa_mensagens(conversation_id, id);

CREATE TABLE IF NOT EXISTS wa_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ia_ativa INTEGER DEFAULT 1,
  account_id TEXT,
  profile_id TEXT,
  nome_empresa TEXT DEFAULT 'NoxMob',
  prompt_sistema TEXT,
  mensagem_boas_vindas TEXT,
  mensagem_fora_horario TEXT,
  horario TEXT,
  atualizado_em TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO wa_config (id, ia_ativa, nome_empresa) VALUES (1, 1, 'NoxMob');

CREATE TABLE IF NOT EXISTS wa_eventos (
  evento_id TEXT PRIMARY KEY,
  tipo TEXT,
  recebido_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_eventos_data ON wa_eventos(recebido_em);
