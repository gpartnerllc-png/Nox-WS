# NoxMob SmartPOS

SmartPOS completo em **Cloudflare Workers + D1**: PDV, estoque, cadastro de clientes, hotel com biometria palm-vein, frigobar, WhatsApp com atendimento automático por IA (Grok + Llama), PIX (Asaas e Banco Inter), carteiras digitais (UPI/Google Pay e Apple Pay), rastreio administrativo por CPF/CNPJ e PWA instalável.

> Versão 2.2.0 · API `waitron-server` · Frontend servido pelo próprio Worker com Cloudflare Assets

---

## 1. Visão geral

O projeto nasceu como um frontend estático com um Worker simples. Esta versão mantém as rotas e os dados antigos e adiciona:

- autenticação real (PBKDF2, sessões opacas, aprovação de usuários, papéis e auditoria);
- login por e-mail **ou CPF/CNPJ** com validação de dígitos verificadores;
- rastreio administrativo de cadastros, sessões, acessos, pagamentos e auditoria por documento;
- persistência de cadastros, vendas, pagamentos e conversas no D1;
- integrações com Zernio (WhatsApp), Asaas, Banco Inter, UPI/Google Pay, Apple Pay e Resend;
- IA de atendimento no WhatsApp e copiloto operacional com xAI Grok e fallback automático para Workers AI (Llama);
- interface clara em porcelana com azul cobalto e laranja solar, botões táteis em 3D e cenas orbitais em canvas;
- PWA com service worker, atalhos, ícones maskable e instalação no Android/iOS/desktop.

Todos os dados de cartão permanecem no provedor de pagamento. O NoxMob **não armazena PAN, CVV ou validade**.

## 2. Arquitetura

```text
Navegador / PWA instalado
        │  HTTPS (mesma origem)
        ▼
Cloudflare Worker  waitron-server
  ├── /auth/*            autenticação, sessões, usuários, auditoria
  ├── /api/*             PDV, produtos, pessoas, vendas, hotel, IA, WhatsApp
  ├── /pay/*             PIX, checkout, UPI, Apple Pay e webhooks
  ├── /webhook/zernio    eventos do WhatsApp (HMAC)
  ├── /health            saúde e capacidades das integrações
  └── Assets             index.html, CSS/JS locais, manifest, ícones, sw.js
        │
        ├── D1 (SQLite): usuários, documentos, acessos, produtos, vendas, pagamentos, conversas, hotel
        ├── IA: xAI Grok (opcional) com fallback para Workers AI (Llama)
        └── APIs externas: Zernio, Asaas, Inter, ViaCEP/CNPJ, Resend
```

## 3. Estrutura do repositório

```text
index.html                  SPA (14 páginas, sem CDN)
assets/app.css              design system e layouts responsivos
assets/app.js               lógica da SPA, APIs, PWA e offline queue
assets/scene.js             cenas 3D em canvas (esferas, órbitas, parallax)
manifest.webmanifest        manifesto PWA
sw.js                       service worker (cache e fallback offline)
icon-*.png, favicon-32.png  ícones do app
schema.sql                  schema completo para instalação nova
migrations/                 migrações incrementais do D1
_headers                    CSP, HSTS e cache dos assets (Workers Assets)
package.json                scripts de dev, deploy, migração e verificação
worker/wrangler.toml        configuração do Worker, D1, assets, IA e cron
worker/src/index.js         roteador e health
worker/src/lib/             auth, HTTP, pagamentos, segurança
worker/src/providers/       asaas, inter, upi, applepay, zernio
worker/.dev.vars.example    modelo de variáveis locais (não versionar o .dev.vars)
```

## 4. Rodando localmente

Pré-requisitos: Node.js 20+, npm e uma conta Cloudflare (para D1 remoto).

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars
```

Edite `worker/.dev.vars` com os valores de desenvolvimento. Depois aplique o schema no D1 local e suba o Worker:

```bash
npm run db:migrate:local
npm run dev
```

Acesse `http://127.0.0.1:8787`. O painel abre na tela de login.

> **Windows + Node 24:** alguns comandos `wrangler d1` podem falhar com `write EOF` (bug do Miniflare no Windows). `npm run dev` e `npm run deploy` não são afetados. Se ocorrer, execute a migração com Node 20/22 LTS ou aplique o SQL de `migrations/` pelo console D1 do dashboard.

### Primeiro administrador

O cadastro público cria usuários como `operador` e status `pendente`. Para criar o primeiro admin, use o `BOOTSTRAP_TOKEN` configurado:

```bash
curl -X POST http://127.0.0.1:8787/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Token: SEU_BOOTSTRAP_TOKEN" \
  -d '{"nome":"Administrador","email":"admin@empresa.com","senha":"senha-forte-com-12-caracteres"}'
```

Senhas exigem no mínimo 8 caracteres. Depois do bootstrap, aprove usuários pendentes em **Usuários** no painel ou via `POST /auth/approve` com sessão de admin.

> Para testar recuperação de senha sem e-mail, use `EXPOSE_RESET_TOKEN=true` **apenas em desenvolvimento**. Em produção mantenha `false` e configure `RESEND_API_KEY`/`RESET_FROM`.

## 5. D1 e migrações

O banco usado pelo Worker é `noxmob-db`. O `database_id` atual está em `worker/wrangler.toml`.

```bash
# banco local
npm run db:migrate:local

# banco remoto (exige confirmação e deve ser feito após backup)
npm run db:backup:remote
npm run db:migrate:remote
```

Para uma conta Cloudflare nova:

```bash
npx wrangler d1 create noxmob-db
```

Copie o `database_id` retornado para `[[d1_databases]]` em `worker/wrangler.toml`.

O schema é idempotente (`CREATE TABLE IF NOT EXISTS`) e a migração `0001_nox_cloud.sql` **não altera** as tabelas legadas; apenas adiciona sessões, auditoria, rate limit, pagamentos, WhatsApp e recebimentos.

A migração `0002_usuarios_docs_acessos.sql` adiciona `usuarios_perfil` (CPF/CNPJ normalizado e único), `acessos` (histórico de login/logout com IP e user-agent) e o índice de documento. O documento é gravado **somente com dígitos**; a validação de CPF/CNPJ acontece no Worker e no frontend. A limpeza diária remove acessos com mais de 365 dias.

## 6. Deploy na Cloudflare

### 6.1. Autenticação do Wrangler

```bash
npx wrangler login
npx wrangler whoami
```

### 6.2. Secrets

Nunca coloque chaves reais em `wrangler.toml`, no frontend ou no Git. Cadastre como secrets:

```bash
npx wrangler secret put XAI_API_KEY -c worker/wrangler.toml
npx wrangler secret put ZERNIO_API_KEY -c worker/wrangler.toml
npx wrangler secret put ZERNIO_ACCOUNT_ID -c worker/wrangler.toml
npx wrangler secret put ZERNIO_PROFILE_ID -c worker/wrangler.toml
npx wrangler secret put ZERNIO_WEBHOOK_SECRET -c worker/wrangler.toml
npx wrangler secret put ASAAS_API_KEY -c worker/wrangler.toml
npx wrangler secret put ASAAS_WEBHOOK_TOKEN -c worker/wrangler.toml
npx wrangler secret put INTER_CLIENT_ID -c worker/wrangler.toml
npx wrangler secret put INTER_CLIENT_SECRET -c worker/wrangler.toml
npx wrangler secret put INTER_PIX_CHAVE -c worker/wrangler.toml
npx wrangler secret put UPI_VPA -c worker/wrangler.toml
npx wrangler secret put BOOTSTRAP_TOKEN -c worker/wrangler.toml
npx wrangler secret put HOTEL_API_KEY -c worker/wrangler.toml
npx wrangler secret put PALM_KEY -c worker/wrangler.toml
npx wrangler secret put RESEND_API_KEY -c worker/wrangler.toml
npx wrangler secret put RESET_FROM -c worker/wrangler.toml
```

`PALM_KEY` deve ser uma chave AES-256 em base64 (32 bytes). Sem ela, os templates são gravados sem criptografia adicional; com ela, são gravados como `enc:v1:...`. O hash SHA-256 continua sendo usado para busca/duplicidade.

### 6.3. Deploy do Worker e do PWA

```bash
npm run check
npm run deploy
```

O `wrangler.toml` já aponta `[assets] directory = "../"`, então o deploy publica o Worker e o PWA juntos. O `.assetsignore` impede a exposição de `worker/`, `.git/`, `.dev.vars`, migrações e arquivos de configuração.

O deploy atualiza `https://waitron-server.contatodroppfy.workers.dev/`. Para usar o domínio final:

1. No dashboard Cloudflare, abra **Workers & Pages → waitron-server → Settings → Domains & Routes**.
2. Adicione `ws.droppfy.com` como **Custom Domain**.
3. Confirme que `APP_URL` e `ALLOWED_ORIGIN` em `wrangler.toml` incluem `https://ws.droppfy.com`.
4. Se o domínio apontava para um Cloudflare Pages antigo, mova o custom domain para o Worker e remova o projeto Pages duplicado.

### 6.4. Cron e mTLS

O cron `17 3 * * *` limpa sessões expiradas, tokens de reset, rate limits e auditoria com mais de 90 dias.

Para Apple Pay e, em produção, para o Banco Inter, crie os certificados em **SSL/TLS → Client Certificates** e descomente os bindings `[[mtls_certificates]]` no `wrangler.toml`, informando os `certificate_id`.

## 7. Variáveis e secrets

### Variáveis públicas (`[vars]`)

| Variável | Uso |
| --- | --- |
| `ENV` | ambiente (`production`/`development`) |
| `APP_URL` | URL pública usada em links de recuperação |
| `ALLOWED_ORIGIN` | origens CORS separadas por vírgula |
| `ZERNIO_BASE` | base da API Zernio |
| `ASAAS_BASE` | sandbox ou produção do Asaas |
| `AI_MODEL` | modelo de Workers AI (Llama) |
| `AI_PROVIDER` | `auto`, `grok` ou `workers-ai`; em `auto` o Grok é tentado primeiro e o Llama entra como fallback |
| `GROK_MODEL` | modelo xAI usado quando há `XAI_API_KEY` |
| `HOTEL_ALLOW_ANON` | permite kiosk sem login (use `false` em produção) |
| `EXPOSE_RESET_TOKEN` | expõe token de reset na resposta (somente dev) |

### Secrets

| Secret | Necessário para | Observações |
| --- | --- | --- |
| `BOOTSTRAP_TOKEN` | primeiro admin | desative/rotacione após o bootstrap |
| `XAI_API_KEY` | Grok | opcional; sem ela o sistema usa Llama automaticamente |
| `ZERNIO_API_KEY` | WhatsApp | nunca versione; rotacione se vazar |
| `ZERNIO_ACCOUNT_ID` | WhatsApp | conta/conexão no Zernio |
| `ZERNIO_PROFILE_ID` | WhatsApp | opcional |
| `ZERNIO_WEBHOOK_SECRET` | webhook | HMAC SHA-256; aceita `X-Zernio-Signature` e variantes |
| `ASAAS_API_KEY` | PIX/checkout | use chave de produção no deploy final |
| `ASAAS_WEBHOOK_TOKEN` | webhook Asaas | enviado no header `asaas-access-token` |
| `INTER_CLIENT_ID` / `INTER_CLIENT_SECRET` | PIX Inter | OAuth2 |
| `INTER_PIX_CHAVE` | PIX Inter | chave PIX cadastrada |
| `UPI_VPA` | UPI/Google Pay | VPA indiana, ex. `loja@banco` |
| `UPI_MERCHANT_NAME` / `UPI_MERCHANT_CODE` | UPI | opcionais |
| `APPLE_PAY_MERCHANT_ID` / `APPLE_PAY_DOMAIN` | Apple Pay | Merchant ID e domínio verificado |
| `APPLE_PAY_DOMAIN_ASSOCIATION` | Apple Pay | conteúdo do arquivo da Apple |
| `APPLE_PAY_PROCESSOR_URL` | Apple Pay | PSP que processa o token |
| `RESEND_API_KEY` / `RESET_FROM` | reset de senha | remetente verificado no Resend |
| `HOTEL_API_KEY` | dispositivos hotel | header `X-Hotel-Key` |
| `PALM_KEY` | biometria | AES-256 em base64 |
| `API_KEY` | integração máquina-a-máquina | opcional; equivale a admin |

## 8. Integrações

### 8.1. Asaas (PIX e checkout hospedado)

- `POST /api/pay/asaas/pix`: cria cobrança PIX e persiste o pagamento.
- `POST /api/pay/asaas/checkout`: cria checkout hospedado; o cliente paga no ambiente Asaas.
- `GET /api/pay/asaas/status/:id`: consulta status.
- Webhook: `POST /pay/asaas/webhook` (ou `/api/pay/asaas/webhook`) com `ASAAS_WEBHOOK_TOKEN`.

Troque `ASAAS_BASE` para `https://api.asaas.com` e use a chave de produção antes de cobrar de verdade.

### 8.2. Banco Inter (PIX)

- `POST /api/pay/inter/pix` e `GET /api/pay/inter/status/:id`.
- Em produção o Inter exige mTLS. Configure `INTER_MTLS` via certificado de cliente da Cloudflare; sem o binding o Worker tenta a chamada sem certificado e pode ser recusado.
- Escopos ajustáveis com `INTER_SCOPES`.

### 8.3. UPI e Google Pay (Índia)

O Worker gera o deep link `upi://pay?...` e o intent Android:

```text
intent://pay?... #Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end
```

O app abre o Google Pay/UPI instalado no dispositivo. A confirmação é manual por admin/gerente em `POST /api/pay/upi/confirm`, pois não há captura automática de liquidação sem um PSP indiano. A moeda é INR e nenhum dado de cartão passa pelo NoxMob.

### 8.4. Apple Pay

Requer Apple Developer Program, Merchant ID, domínio verificado, certificado mTLS e um PSP para processar o token.

- O arquivo `/.well-known/apple-developer-merchantid-domain-association` é servido a partir de `APPLE_PAY_DOMAIN_ASSOCIATION`.
- `POST /api/pay/applepay/session` valida a sessão de merchant com a Apple.
- O botão/fluxo Apple Pay JS e a captura final dependem do PSP configurado em `APPLE_PAY_PROCESSOR_URL`.

Sem esses itens o painel mostra Apple Pay como não configurado; nada é simulado.

### 8.5. WhatsApp com IA (Zernio)

1. Configure `ZERNIO_API_KEY`, `ZERNIO_ACCOUNT_ID` e `ZERNIO_WEBHOOK_SECRET`.
2. Registre o webhook `https://ws.droppfy.com/webhook/zernio` no Zernio.
3. Ative a IA em **WhatsApp → Configuração**. A IA responde automaticamente, com histórico por conversa, opção de pausa e opt-out.
4. O webhook valida HMAC, aplica janela de timestamp de 5 minutos e grava eventos para evitar duplicidade.

O Grok (`XAI_API_KEY`, `GROK_MODEL`) é usado primeiro quando `AI_PROVIDER=auto`; se a chamada falhar ou a chave não existir, o Worker cai automaticamente para Workers AI (Llama). O `/health` informa qual provedor está ativo, sem expor chaves. Se nenhum modelo responder, o sistema retorna respostas determinísticas de fallback.

### 8.6. Rastreio de cadastros por CPF/CNPJ

Rotas administrativas (exigem sessão `admin`):

- `GET /auth/users/lookup?q=CPF|CNPJ|email|nome` — retorna usuários, sessões, histórico de acessos, pessoas/leads, pagamentos e auditoria relacionados ao termo.
- `POST /auth/users/doc` — vincula ou altera o CPF/CNPJ de um usuário (`{ email, doc }`), validando dígitos verificadores e unicidade.

No painel, **Usuários → Rastrear acessos** executa a consulta; cada linha da tabela tem atalhos para rastrear pelo documento e para vincular/alterar o CPF/CNPJ. A consulta é registrada na auditoria como `consulta_cadastro` e nunca retorna senhas, hashes ou dados de cartão. O CPF/CNPJ completo é visível apenas para administradores.

### 8.7. Consulta de CNPJ/CEP e e-mail

- `GET /cnpj/:valor` e `GET /cep/:valor` consultam bases públicas com cache.
- `POST /auth/forgot` usa Resend quando configurado. Sem provedor, o token não é enviado (e só aparece com `EXPOSE_RESET_TOKEN=true` em desenvolvimento).

## 9. Segurança e privacidade

- Senhas: PBKDF2-SHA256 com 210.000 iterações e salt aleatório.
- Sessões: token opaco de 32 bytes; apenas o hash SHA-256 é gravado no D1; expiração de 30 dias; logout revoga.
- Rate limit por IP/usuário nas rotas sensíveis (login, cadastro, reset, pagamentos).
- Auditoria de login, CRUD, pagamentos, WhatsApp e ações administrativas.
- CPF/CNPJ armazenado apenas com dígitos, validado por dígitos verificadores, único por conta e visível somente para administradores; histórico de acessos expurgado após 365 dias.
- CORS restrito por `ALLOWED_ORIGIN`.
- Respostas estáticas com CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` e HSTS em HTTPS.
- Nenhum PAN/CVV/validade é recebido ou armazenado. Checkout Asaas é hospedado; carteiras usam tokenização do provedor/dispositivo.
- Templates palm-vein: hash SHA-256 para busca + AES-GCM quando `PALM_KEY` está configurada.
- Segredos somente via Wrangler secrets; `.dev.vars` está no `.gitignore`.
- Escape de HTML em toda a renderização dinâmica do frontend.

> Se alguma chave foi compartilhada em chat, documento ou commit, rotacione no provedor antes de ir para produção. Este repositório não contém as chaves reais.

## 10. Modelo de dados

Tabelas legadas preservadas: `usuarios`, `produtos`, `pessoas`, `vendas`, `leads`, `reset_senha`, `palm_templates`, `hospede_quarto`, `consumos_hotel`, `frigobar_itens`, `frigobar_movimentacao`.

Novas tabelas: `sessoes`, `auditoria`, `rate_limits`, `sync_receipts`, `pagamentos`, `wa_conversas`, `wa_mensagens`, `wa_config`, `wa_eventos`, `usuarios_perfil`, `acessos`.

## 11. PWA e aplicativo instalável

O PWA já está pronto para instalação:

- Android/Chrome: botão **Instalar app** (evento `beforeinstallprompt`).
- iOS/Safari: **Compartilhar → Adicionar à Tela de Início**.
- Desktop: ícone de instalação na barra de endereço.
- Atalhos: PDV, WhatsApp e Pagamentos via `/?page=...`.
- Offline: o shell é servido pelo cache; vendas entram em fila local e sincronizam quando a conexão volta.

### Gerar APK/AAB

O projeto é um PWA. Para publicar nas lojas, gere o pacote com PWABuilder ou Bubblewrap usando a URL publicada:

```bash
# exemplo com Bubblewrap (requer Android SDK/JDK)
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://ws.droppfy.com/manifest.webmanifest
bubblewrap build
```

O PWABuilder também gera APK/AAB assinados a partir da mesma URL. O pacote usa o manifest, os ícones e o service worker deste repositório; não é necessário duplicar o código.

## 12. Operação

```bash
npx wrangler tail waitron-server -c worker/wrangler.toml
curl https://ws.droppfy.com/health
```

O `/health` retorna a versão e quais integrações estão configuradas (sem expor chaves). Use-o após cada deploy.

Backup do D1:

```bash
npm run db:backup:remote
```

## 13. Checklist antes de produção

- [ ] `npm run check` sem erros.
- [ ] Migração aplicada no D1 correto e backup feito (`0001` e `0002`).
- [ ] Todos os secrets cadastrados; `.dev.vars` fora do Git.
- [ ] Chaves antigas rotacionadas (Zernio, Asaas, Inter, xAI).
- [ ] `APP_URL`, `ALLOWED_ORIGIN` e custom domain corretos.
- [ ] `HOTEL_ALLOW_ANON=false` e `EXPOSE_RESET_TOKEN=false`.
- [ ] `ASAAS_BASE` de produção e chave live.
- [ ] Webhooks Asaas e Zernio apontando para o domínio final.
- [ ] Certificados mTLS do Inter e Apple Pay instalados, se usados.
- [ ] Primeiro admin criado e `BOOTSTRAP_TOKEN` rotacionado.
- [ ] Teste de login, venda, PIX sandbox, WhatsApp e instalação do PWA.
- [ ] Teste de cadastro/login por CPF/CNPJ, vínculo de documento e rastreio de acessos no painel admin.

## 14. Limitações conhecidas

- UPI é uma rede indiana e a confirmação é manual sem um PSP local.
- Apple Pay depende de PSP para capturar o pagamento; o Worker entrega a validação de merchant e a estrutura de sessão.
- O Banco Inter exige mTLS em produção.
- A IA do WhatsApp depende da cota de Workers AI e do Zernio; há fallback determinístico.
- O modo offline sincroniza vendas pendentes, mas não substitui um ERP fiscal completo.
