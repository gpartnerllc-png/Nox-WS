-- NoxMob · schema base (idempotente)
-- Banco: noxmob-db (Cloudflare D1)
-- Uso local:    npx wrangler d1 execute noxmob-db --local  --file=./schema.sql -c worker/wrangler.toml
-- Uso remoto:   npx wrangler d1 execute noxmob-db --remote --file=./schema.sql -c worker/wrangler.toml
-- Depois:       npx wrangler d1 migrations apply noxmob-db --remote -c worker/wrangler.toml

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  nome TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'operador',
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  barras TEXT,
  ncm TEXT,
  cnp TEXT,
  preco REAL NOT NULL DEFAULT 0,
  estoque INTEGER NOT NULL DEFAULT 0,
  icms REAL NOT NULL DEFAULT 18,
  cfop TEXT DEFAULT '5102',
  loja_id TEXT DEFAULT 'default',
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pessoas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  doc TEXT,
  tipo TEXT DEFAULT 'PF',
  tel TEXT,
  email TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT,
  total REAL NOT NULL DEFAULT 0,
  impostos REAL NOT NULL DEFAULT 0,
  cbs_ibs REAL NOT NULL DEFAULT 0,
  detalhe_json TEXT,
  data TEXT,
  usuario_email TEXT,
  cliente_nome TEXT,
  cliente_tel TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  tel TEXT,
  doc TEXT,
  compras INTEGER DEFAULT 0,
  ultima_compra TEXT,
  valor REAL DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reset_senha (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expira TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS palm_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospede_id INTEGER NOT NULL,
  template_hash TEXT NOT NULL UNIQUE,
  template_b64 TEXT,
  device_id TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (hospede_id) REFERENCES pessoas(id)
);

CREATE TABLE IF NOT EXISTS hospede_quarto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospede_id INTEGER NOT NULL,
  quarto TEXT NOT NULL,
  checkin TEXT DEFAULT (datetime('now')),
  checkout TEXT,
  status TEXT DEFAULT 'ocupado',
  FOREIGN KEY (hospede_id) REFERENCES pessoas(id)
);

CREATE TABLE IF NOT EXISTS consumos_hotel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quarto TEXT NOT NULL,
  hospede_id INTEGER,
  descricao TEXT NOT NULL DEFAULT 'Consumo Frigobar',
  valor REAL NOT NULL,
  pago_via TEXT DEFAULT 'palma',
  txid_pix TEXT,
  status TEXT DEFAULT 'pago',
  device_id TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS frigobar_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  preco REAL NOT NULL DEFAULT 0,
  estoque INTEGER NOT NULL DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 3,
  ativo INTEGER DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS frigobar_movimentacao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  quarto TEXT,
  quantidade INTEGER NOT NULL,
  tipo TEXT DEFAULT 'consumo',
  consumo_id INTEGER,
  criado_em TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES frigobar_itens(id)
);

-- ============================================================
-- CLOUD / IA / PAGAMENTOS / WHATSAPP
-- ============================================================

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

-- CPF/CNPJ do usuário (somente dígitos) e último acesso.
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

-- Histórico de logins para o painel administrativo de rastreamento.
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

CREATE INDEX IF NOT EXISTS idx_produtos_sku ON produtos(sku);
CREATE INDEX IF NOT EXISTS idx_produtos_barras ON produtos(barras);
CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data);
CREATE INDEX IF NOT EXISTS idx_leads_tel ON leads(tel);
CREATE INDEX IF NOT EXISTS idx_palm_hash ON palm_templates(template_hash);
CREATE INDEX IF NOT EXISTS idx_hospede_quarto ON hospede_quarto(quarto, status);
CREATE INDEX IF NOT EXISTS idx_consumos_quarto ON consumos_hotel(quarto);
CREATE INDEX IF NOT EXISTS idx_frigobar_sku ON frigobar_itens(sku);

-- Primeiro administrador: use POST /auth/bootstrap com BOOTSTRAP_TOKEN.
-- Não há senha padrão no código nem no banco.
INSERT OR IGNORE INTO frigobar_itens (sku, nome, preco, estoque, estoque_minimo) VALUES
('FRIG-AGUA', 'Água Mineral 500ml', 6.00, 50, 10),
('FRIG-COCA', 'Coca-Cola 350ml', 9.00, 40, 8),
('FRIG-CERV', 'Cerveja Long Neck', 12.00, 30, 6),
('FRIG-CHOCO', 'Chocolate', 8.50, 25, 5),
('FRIG-SNACK', 'Salgadinho', 7.00, 35, 7);
