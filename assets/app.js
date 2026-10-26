/* NoxMob SmartPOS · app principal */
// No Worker a API é same-origin; em hospedagem estática (Pages/local) aponta para o Worker.
const API_HOSTS = ['waitron-server.contatodroppfy.workers.dev', 'ws.droppfy.com'];
const API_BASE = API_HOSTS.includes(location.hostname) ? '' : 'https://waitron-server.contatodroppfy.workers.dev';
const TOKEN_KEY = 'noxmob.session.token';
const USER_KEY = 'noxmob.session.user';
const CACHE_KEY = 'noxmob.cache.v4';
const QUEUE_KEY = 'noxmob.queue.v1';
const PAGE_META = {
  dashboard: ['Visão geral', 'Sua operação em tempo real'],
  pdv: ['PDV / Caixa', 'Venda rápida com cálculo fiscal no servidor'],
  produtos: ['Produtos', 'Catálogo, preço e tributação por item'],
  estoque: ['Estoque', 'Posição consolidada e reposição'],
  pessoas: ['Pessoas & Leads', 'Cadastros, histórico e contato por WhatsApp'],
  whatsapp: ['WhatsApp IA', 'Conversas, automação e atendimento humano'],
  palm: ['Palma / Hóspedes', 'Check-in biométrico e consumo no quarto'],
  frigobar: ['Frigobar', 'Estoque por apartamento e reposição'],
  consumos: ['Consumos do hotel', 'Histórico de cobranças por quarto'],
  relatorios: ['Relatórios & DRE', 'Resultado operacional e exportações'],
  fiscal: ['Fiscal CBS / IBS', 'Memória de cálculo e tributação do catálogo'],
  pagamentos: ['Pagamentos', 'PIX, checkout hospedado e carteiras digitais'],
  usuarios: ['Usuários & Auditoria', 'CPF/CNPJ, acessos, papéis e rastreabilidade'],
  config: ['Configurações', 'Infraestrutura, integrações e aplicativo'],
};

const S = {
  token: safeGet(TOKEN_KEY) || '',
  user: safeJson(USER_KEY, null),
  products: [],
  people: [],
  leads: [],
  users: [],
  sales: [],
  payments: [],
  frigo: [],
  guests: [],
  consumos: [],
  dashboard: null,
  insights: null,
  providers: null,
  health: null,
  wa: { status: null, conversations: [], active: null, messages: [], config: null },
  cart: [],
  period: 30,
  page: 'dashboard',
  lastSync: 0,
  lastDashboard: 0,
  lastWa: 0,
  lastHotel: 0,
  lastPayments: 0,
  loading: {},
  waTimer: null,
  scanner: null,
  deferredPrompt: null,
  queueSyncing: false,
  aiHistory: [],
};

class ApiError extends Error {
  constructor(message, status = 0, code = '', data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/* ── utilities ─────────────────────────────────────────── */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function safeGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function safeJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function safeSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* storage indisponível */
  }
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}
function money(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}
function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}
function digits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}
function maskDoc(value) {
  const doc = digits(value).slice(0, 14);
  if (!doc) return '';
  if (doc.length <= 11) {
    return doc
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }
  return doc
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}
function validCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (slice) => {
    let sum = 0;
    for (let i = 0; i < slice.length; i += 1) sum += Number(cpf[i]) * (slice.length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(cpf.slice(0, 9)) === Number(cpf[9]) && calc(cpf.slice(0, 10)) === Number(cpf[10]);
}
function validCnpj(value) {
  const cnpj = digits(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (slice, weights) => {
    const sum = slice.split('').reduce((acc, digit, index) => acc + Number(digit) * weights[index], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = calc(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calc(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}
function docType(value) {
  if (validCpf(value)) return 'CPF';
  if (validCnpj(value)) return 'CNPJ';
  return '';
}
function fmtDoc(value) {
  const doc = digits(value);
  if (!doc) return '—';
  return maskDoc(doc);
}
function initials(name) {
  const parts = String(name || 'NoxMob').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'NX';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
function firstName(name) {
  return String(name || 'operador').trim().split(/\s+/)[0];
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}
function fmtDateTime(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function fmtTime(value) {
  const date = parseDate(value);
  if (!date) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtShortDay(value) {
  const date = parseDate(value);
  if (!date) return String(value || '').slice(5);
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function dayKey(value) {
  return String(value || '').slice(0, 10);
}
function debounce(fn, delay = 260) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `nox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
function busy(button, active, label = 'Processando…') {
  if (!button) return;
  if (active) {
    if (!button.dataset.original) button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.original) {
      button.innerHTML = button.dataset.original;
      delete button.dataset.original;
    }
  }
}
function statusPill(status) {
  const labels = {
    pago: ['Recebido', 'pill-mint'],
    pendente: ['Pendente', 'pill-amber'],
    cancelado: ['Cancelado', 'pill-rose'],
    expirado: ['Expirado', 'pill-slate'],
    falhou: ['Falhou', 'pill-rose'],
    ativo: ['Ativo', 'pill-mint'],
    bloqueado: ['Bloqueado', 'pill-rose'],
    pendente_aprovacao: ['Pendente', 'pill-amber'],
  };
  const [label, cls] = labels[status] || [status || '—', 'pill-slate'];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}
function canManage() {
  return ['admin', 'gerente'].includes(S.user?.papel);
}
function isAdmin() {
  return S.user?.papel === 'admin';
}
function cacheData() {
  safeSet(CACHE_KEY, {
    products: S.products,
    people: S.people,
    leads: S.leads,
    sales: S.sales,
    payments: S.payments,
    frigo: S.frigo,
    guests: S.guests,
    consumos: S.consumos,
    dashboard: S.dashboard,
    providers: S.providers,
    waConversations: S.wa.conversations,
    health: S.health,
    savedAt: new Date().toISOString(),
  });
}
function hydrateCache() {
  const cache = safeJson(CACHE_KEY, null);
  if (!cache) return false;
  S.products = Array.isArray(cache.products) ? cache.products : [];
  S.people = Array.isArray(cache.people) ? cache.people : [];
  S.leads = Array.isArray(cache.leads) ? cache.leads : [];
  S.sales = Array.isArray(cache.sales) ? cache.sales : [];
  S.payments = Array.isArray(cache.payments) ? cache.payments : [];
  S.frigo = Array.isArray(cache.frigo) ? cache.frigo : [];
  S.guests = Array.isArray(cache.guests) ? cache.guests : [];
  S.consumos = Array.isArray(cache.consumos) ? cache.consumos : [];
  S.dashboard = cache.dashboard || null;
  S.providers = cache.providers || null;
  S.wa.conversations = Array.isArray(cache.waConversations) ? cache.waConversations : [];
  S.health = cache.health || null;
  return true;
}
function toast(message, type = 'info', ttl = 4200) {
  const area = $('#toastArea');
  if (!area) return;
  const icons = { ok: 'i-check', err: 'i-close', info: 'i-bolt' };
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<svg><use href="#${icons[type] || icons.info}"/></svg><span>${esc(message)}</span>`;
  area.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, ttl);
}
function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado para a área de transferência.', 'ok');
  } catch {
    toast('Não foi possível copiar automaticamente. Selecione o texto manualmente.', 'err');
  }
}
function openExternal(url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="table-empty">${esc(text)}</td></tr>`;
}

/* ── API client ────────────────────────────────────────── */
async function api(path, options = {}) {
  const { method = 'GET', body, timeout = 30000, auth = true } = options;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && S.token) headers.Authorization = `Bearer ${S.token}`;
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(
      error?.name === 'AbortError' ? 'O servidor demorou para responder.' : 'Sem conexão com o servidor.',
      0,
      'NETWORK'
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { erro: text };
  }
  if (!response.ok) {
    if (response.status === 401 && auth && S.token) {
      expireSession();
    }
    throw new ApiError(
      data?.erro || data?.error || data?.msg || `Erro ${response.status}`,
      response.status,
      data?.codigo || data?.code || '',
      data
    );
  }
  return data;
}

function expireSession() {
  S.token = '';
  S.user = null;
  safeSet(TOKEN_KEY, null);
  safeSet(USER_KEY, null);
  stopWaTimer();
  showAuth('Sua sessão expirou. Entre novamente.');
}

/* ── session & auth ────────────────────────────────────── */
function saveSession(token, usuario) {
  S.token = token;
  S.user = usuario;
  safeSet(TOKEN_KEY, token);
  safeSet(USER_KEY, usuario);
}
function showAuth(message = '') {
  $('#appView').hidden = true;
  $('#authView').hidden = false;
  document.body.classList.remove('in-app');
  const fab = $('#aiFab');
  if (fab) fab.hidden = true;
  closeSidebar();
  closeAi();
  setAuthMsg(message, message ? 'err' : '');
  const loginEmail = $('#loginEmail');
  if (loginEmail) setTimeout(() => loginEmail.focus(), 120);
}
function showApp() {
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  document.body.classList.add('in-app');
  const fab = $('#aiFab');
  if (fab) fab.hidden = false;
  const nome = S.user?.nome || 'Operador';
  const papel = S.user?.papel || 'operador';
  const ini = initials(nome);
  ['avatarInitials', 'avatarInitialsTop'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = ini;
  });
  ['userName', 'userNameTop'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = nome;
  });
  ['userRole', 'userRoleTop'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = papel;
  });
  const heroName = $('#heroName');
  if (heroName) heroName.textContent = firstName(nome);
  const sysSession = $('#sysSession');
  if (sysSession) sysSession.textContent = S.user?.email || '—';
  document.querySelectorAll('.nav-item[data-page="usuarios"]').forEach((item) => {
    item.hidden = !isAdmin();
  });
  setTimeout(() => window.NoxScene?.initAll(), 80);
}
function setAuthMsg(message, kind = '') {
  const box = $('#authMsg');
  if (!box) return;
  box.hidden = !message;
  box.className = `auth-msg ${kind || ''}`.trim();
  box.textContent = message || '';
}
function switchAuthTab(tab) {
  $$('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
  $$('.auth-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.authPanel === tab));
  setAuthMsg('');
}

async function handleLogin(event) {
  event.preventDefault();
  const button = $('#loginSubmit');
  const identificador = $('#loginEmail').value.trim();
  const senha = $('#loginPassword').value;
  if (!identificador || !senha) return setAuthMsg('Informe e-mail ou CPF/CNPJ e senha.', 'err');
  if (!identificador.includes('@') && !docType(identificador)) {
    return setAuthMsg('Informe um e-mail ou um CPF/CNPJ válido.', 'err');
  }
  busy(button, true, 'Entrando…');
  setAuthMsg('');
  try {
    const data = await api('/auth/login', { method: 'POST', body: { identificador, senha }, auth: false });
    if (!data?.token) throw new ApiError('Resposta de login inválida.');
    saveSession(data.token, data.usuario);
    $('#loginPassword').value = '';
    showApp();
    hydrateCache();
    renderAll();
    navigate(S.page || 'dashboard');
    await loadAll();
    toast(`Bem-vindo, ${firstName(data.usuario.nome)}.`, 'ok');
  } catch (error) {
    setAuthMsg(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const button = $('#registerSubmit');
  const nome = $('#registerName').value.trim();
  const email = $('#registerEmail').value.trim();
  const doc = $('#registerDoc')?.value.trim() || '';
  const senha = $('#registerPassword').value;
  if (senha.length < 8) return setAuthMsg('A senha precisa ter pelo menos 8 caracteres.', 'err');
  const tipo = docType(doc);
  if (!tipo) return setAuthMsg('Informe um CPF ou CNPJ válido com dígitos verificadores.', 'err');
  busy(button, true, 'Enviando…');
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: { nome, email, senha, doc: digits(doc) },
      auth: false,
    });
    setAuthMsg(data?.msg || 'Cadastro solicitado. Aguarde aprovação.', 'ok');
    $('#registerForm').reset();
    switchAuthTab('login');
    $('#loginEmail').value = email;
    setAuthMsg(data?.msg || 'Cadastro solicitado. Aguarde aprovação.', 'ok');
  } catch (error) {
    setAuthMsg(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

async function handleForgot(event) {
  event.preventDefault();
  const button = $('#forgotSubmit');
  const email = $('#forgotEmail').value.trim();
  busy(button, true, 'Enviando…');
  try {
    const data = await api('/auth/forgot', { method: 'POST', body: { email }, auth: false });
    setAuthMsg(data?.msg || 'Se o e-mail existir, enviaremos instruções.', 'ok');
    if (data?.tokenDev) {
      $('#resetForm').hidden = false;
      $('#resetEmail').value = email || '';
      $('#resetToken').value = data.tokenDev;
      setAuthMsg('Ambiente local: use o token preenchido para redefinir a senha.', 'ok');
    } else {
      setAuthMsg(`${data?.msg || 'Se o e-mail existir, enviaremos instruções.'} Quando receber o link, abra-o para criar a nova senha.`, 'ok');
    }
  } catch (error) {
    setAuthMsg(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

async function handleReset(event) {
  event.preventDefault();
  const button = $('#resetSubmit');
  const email = $('#resetEmail').value.trim();
  const token = $('#resetToken').value.trim();
  const senha = $('#resetPassword').value;
  if (senha.length < 8) return setAuthMsg('A nova senha precisa ter pelo menos 8 caracteres.', 'err');
  busy(button, true, 'Redefinindo…');
  try {
    const data = await api('/auth/reset', { method: 'POST', body: { email, token, senha }, auth: false });
    $('#resetForm').reset();
    $('#resetForm').hidden = true;
    switchAuthTab('login');
    $('#loginEmail').value = email;
    setAuthMsg(data?.msg || 'Senha atualizada. Faça login novamente.', 'ok');
  } catch (error) {
    setAuthMsg(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

async function handleLogout(force = false) {
  if (!force) {
    const confirmed = await confirmDialog({
      title: 'Encerrar sessão?',
      message: 'Você precisará entrar novamente para acessar o painel.',
      confirmLabel: 'Sair',
      danger: true,
    });
    if (!confirmed) return;
  }
  try {
    if (S.token) await api('/auth/logout', { method: 'POST' });
  } catch {
    /* sessão local será descartada de qualquer forma */
  }
  S.token = '';
  S.user = null;
  safeSet(TOKEN_KEY, null);
  safeSet(USER_KEY, null);
  S.cart = [];
  stopWaTimer();
  showAuth('Sessão encerrada com segurança.');
}

function checkResetLink() {
  const params = new URLSearchParams(location.search);
  const token = params.get('reset');
  const email = params.get('email');
  if (!token) return;
  switchAuthTab('forgot');
  const resetForm = $('#resetForm');
  if (resetForm) resetForm.hidden = false;
  $('#resetEmail').value = email || '';
  $('#resetToken').value = token;
  setAuthMsg('Crie uma nova senha para concluir a recuperação.', 'ok');
  history.replaceState({}, '', location.pathname);
}

async function checkPublicHealth() {
  try {
    const data = await api('/health', { auth: false });
    const chip = $('#authEnvChip');
    if (chip) chip.textContent = data.capabilities?.d1 ? 'Edge · D1' : 'Edge';
    const version = $('#authVersion');
    if (version && data.version) version.textContent = `v${data.version}`;
    const sysVersion = $('#sysVersion');
    if (sysVersion && data.version) sysVersion.textContent = data.version;
    const sysEnv = $('#sysEnv');
    if (sysEnv && data.env) sysEnv.textContent = data.env;
    S.health = data;
  } catch {
    const chip = $('#authEnvChip');
    if (chip) chip.textContent = 'Offline';
  }
}

/* ── bootstrap ─────────────────────────────────────────── */
async function init() {
  const deepPage = new URLSearchParams(location.search).get('page');
  if (PAGE_META[deepPage]) {
    S.page = deepPage;
    const clean = new URL(location.href);
    clean.searchParams.delete('page');
    history.replaceState({}, '', `${clean.pathname}${clean.search}${clean.hash}`);
  }
  bindGlobalEvents();
  bindAuthForms();
  bindForms();
  setupPWA();
  setHeroDate();
  checkResetLink();
  checkPublicHealth();
  updateQueueBadge();

  const token = safeGet(TOKEN_KEY);
  if (token) {
    S.token = token;
    try {
      const data = await api('/auth/me');
      S.user = data.usuario;
      safeSet(USER_KEY, data.usuario);
      showApp();
      hydrateCache();
      renderAll();
      navigate(S.page || 'dashboard');
      await loadAll();
    } catch (error) {
      if (error.status === 401) {
        showAuth('Sua sessão expirou. Entre novamente.');
      } else if (S.user) {
        showApp();
        hydrateCache();
        renderAll();
        navigate(S.page || 'dashboard');
        setConnection(false);
        toast('Modo offline: exibindo os últimos dados sincronizados.', 'info', 6000);
        updateQueueBadge();
      } else {
        showAuth('Não foi possível validar a sessão. Conecte-se e entre novamente.');
      }
    }
  } else {
    showAuth('');
  }
  const splash = $('#bootSplash');
  if (splash) {
    setTimeout(() => splash.classList.add('done'), 420);
    setTimeout(() => splash.remove(), 1000);
  }
  setTimeout(() => setupPWAInstallVisibility(), 700);
}

async function loadAll() {
  await Promise.allSettled([
    loadSync(),
    loadDashboardPage(),
    loadWa(),
    loadHotel(),
    loadProviders(),
    loadPayments(),
    loadUsers(),
    loadHealth(),
  ]);
  syncQueue();
  renderAll();
}

/* ── navigation ────────────────────────────────────────── */
function navigate(page, options = {}) {
  if (!PAGE_META[page]) page = 'dashboard';
  if (page === 'usuarios' && !isAdmin()) page = 'dashboard';
  S.page = page;
  $$('[data-page-section]').forEach((section) => section.classList.toggle('active', section.dataset.pageSection === page));
  $$('.nav-item[data-page], .bottom-nav [data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  const [title, subtitle] = PAGE_META[page];
  const titleEl = $('#pageTitle');
  const subtitleEl = $('#pageSubtitle');
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  closeSidebar();
  if (!options.keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'whatsapp') {
    startWaTimer();
    loadWa();
  } else {
    stopWaTimer();
  }
  ensurePage(page);
}
function ensurePage(page) {
  const stale = (timestamp, ms) => !timestamp || Date.now() - timestamp > ms;
  if (page === 'dashboard' && stale(S.lastDashboard, 45000)) loadDashboardPage();
  if (['produtos', 'estoque', 'pessoas', 'relatorios', 'fiscal', 'pdv'].includes(page) && stale(S.lastSync, 60000)) loadSync();
  if (page === 'whatsapp' && stale(S.lastWa, 30000)) loadWa();
  if (['palm', 'consumos', 'frigobar'].includes(page) && stale(S.lastHotel, 30000)) loadHotel();
  if (page === 'pagamentos') {
    loadProviders();
    if (stale(S.lastPayments, 30000)) loadPayments();
  }
  if (page === 'usuarios') loadUsers();
  if (page === 'config') loadHealth();
}
function openSidebar() {
  $('#sidebar')?.classList.add('open');
  $('#sidebarBackdrop')?.classList.add('open');
}
function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebarBackdrop')?.classList.remove('open');
}

/* ── data loading ──────────────────────────────────────── */
async function loadSync(showErrors = false) {
  if (S.loading.sync) return;
  S.loading.sync = true;
  try {
    const data = await api('/api/sync');
    S.products = data.produtos || [];
    S.sales = data.vendas || [];
    S.people = data.pessoas || [];
    S.leads = data.leads || [];
    S.payments = data.pagamentos || S.payments;
    S.frigo = data.frigobar?.length ? data.frigobar : S.frigo;
    S.lastSync = Date.now();
    cacheData();
    renderAll();
  } catch (error) {
    if (showErrors || error.status !== 401) toast(`Não foi possível sincronizar: ${error.message}`, 'err');
    if (error.code === 'NETWORK') setConnection(false);
  } finally {
    S.loading.sync = false;
  }
}

async function loadDashboardPage() {
  if (S.loading.dashboard) return;
  S.loading.dashboard = true;
  try {
    const data = await api('/api/dashboard');
    S.dashboard = data;
    S.lastDashboard = Date.now();
    cacheData();
    renderDashboard();
    renderStock();
    updateNavBadges();
    setConnection(true);
    loadInsights();
  } catch (error) {
    if (error.status !== 401) toast(`Painel: ${error.message}`, 'err');
    if (S.dashboard) renderDashboard();
    if (error.code === 'NETWORK') setConnection(false);
  } finally {
    S.loading.dashboard = false;
  }
}

async function loadInsights() {
  const list = $('#insightsList');
  try {
    const data = await api('/api/ai/insights');
    S.insights = data;
    if (list) {
      const items = (data.insights || []).map(
        (text) => `<div class="insight-item"><svg><use href="#i-sparkles"/></svg><span>${esc(text)}</span></div>`
      );
      list.innerHTML = items.join('') || '<p class="muted small">Sem insights agora.</p>';
    }
    const source = $('#insightsSource');
    if (source) {
      source.textContent =
        data.fonte === 'grok' ? 'Grok conectado' : data.fonte === 'workers-ai' ? 'Llama conectado' : 'Regras locais';
    }
  } catch (error) {
    if (list) list.innerHTML = `<div class="insight-item"><svg><use href="#i-bolt"/></svg><span>${esc(error.message)}</span></div>`;
  }
}

async function loadProducts() {
  try {
    const data = await api('/api/produtos?limit=500');
    S.products = data.produtos || [];
    cacheData();
    renderProducts();
    renderStock();
    updateNavBadges();
  } catch (error) {
    toast(`Produtos: ${error.message}`, 'err');
  }
}

async function loadWa() {
  if (S.loading.wa) return;
  S.loading.wa = true;
  try {
    const [status, conversations] = await Promise.all([
      api('/api/wa/status'),
      api('/api/wa/conversations?limit=80'),
    ]);
    S.wa.status = status;
    S.wa.config = status.config || null;
    S.wa.conversations = conversations.conversas || [];
    S.lastWa = Date.now();
    renderWaStatus();
    renderWaConversations();
    renderWaConfig();
    cacheData();
    updateNavBadges();
    if (S.wa.active) await reloadActiveConversation(true);
  } catch (error) {
    if (error.status !== 401) toast(`WhatsApp: ${error.message}`, 'err');
  } finally {
    S.loading.wa = false;
  }
}

async function loadWaConversationsOnly() {
  try {
    const data = await api('/api/wa/conversations?limit=80');
    S.wa.conversations = data.conversas || [];
    renderWaConversations();
    updateNavBadges();
  } catch {
    /* mantém a última lista */
  }
}

async function loadHotel() {
  if (S.loading.hotel) return;
  S.loading.hotel = true;
  try {
    const [guests, consumos, frigo] = await Promise.all([
      api('/api/hotel/hospedes'),
      api('/api/palm/consumos?limit=120'),
      api('/api/frigobar/estoque'),
    ]);
    S.guests = guests.hospedes || [];
    S.consumos = consumos.consumos || [];
    S.frigo = frigo.itens || S.frigo;
    S.lastHotel = Date.now();
    cacheData();
    renderGuests();
    renderConsumos();
    renderFrigo();
    renderChargeItems();
    updateNavBadges();
  } catch (error) {
    if (error.status !== 401) toast(`Hotel: ${error.message}`, 'err');
  } finally {
    S.loading.hotel = false;
  }
}

async function loadFrigobar() {
  try {
    const data = await api('/api/frigobar/estoque');
    S.frigo = data.itens || [];
    renderFrigo();
    renderChargeItems();
  } catch (error) {
    toast(`Frigobar: ${error.message}`, 'err');
  }
}

async function loadProviders() {
  try {
    const data = await api('/api/pagamentos/providers');
    S.providers = data.provedores || null;
    cacheData();
    renderProviders();
  } catch (error) {
    if (S.providers) renderProviders();
    else toast(`Provedores: ${error.message}`, 'err');
  }
}

async function loadPayments() {
  try {
    const data = await api('/api/pagamentos?limit=100');
    S.payments = data.pagamentos || [];
    S.lastPayments = Date.now();
    cacheData();
    renderPayments();
  } catch (error) {
    if (S.payments.length) renderPayments();
    else toast(`Pagamentos: ${error.message}`, 'err');
  }
}

async function loadUsers() {
  const tracker = $('#trackerPanel');
  if (!isAdmin()) {
    if (tracker) tracker.hidden = true;
    const body = $('#usersBody');
    if (body) body.innerHTML = emptyRow(6, 'Apenas administradores podem gerenciar usuários.');
    const audit = $('#auditBody');
    if (audit) audit.innerHTML = emptyRow(5, 'Auditoria disponível para administradores.');
    setText('#usersFiltered', '');
    const filtered = $('#usersFiltered');
    if (filtered) filtered.hidden = true;
    renderChangePasswordGate();
    return;
  }
  if (tracker) tracker.hidden = false;
  try {
    const [users, audit] = await Promise.all([api('/auth/users'), api('/auth/audit')]);
    renderUsers(users.usuarios || []);
    renderAudit(audit.eventos || []);
  } catch (error) {
    const body = $('#usersBody');
    if (body) body.innerHTML = emptyRow(6, error.message);
  }
}

async function loadHealth() {
  try {
    const data = await api('/health');
    S.health = data;
    cacheData();
    renderHealth();
    setConnection(true);
  } catch (error) {
    setConnection(false);
    if (S.health) renderHealth();
  }
}

/* ── render: dashboard ─────────────────────────────────── */
function renderAll() {
  renderDashboard();
  renderPdvProducts();
  renderCart();
  renderProducts();
  renderStock();
  renderPeople();
  renderLeads();
  renderGuests();
  renderConsumos();
  renderFrigo();
  renderChargeItems();
  renderProviders();
  renderPayments();
  renderWaStatus();
  renderWaConversations();
  renderWaConfig();
  renderReports();
  renderFiscal();
  renderHealth();
  updateNavBadges();
  updateQueueBadge();
}

function renderDashboard() {
  const dash = S.dashboard;
  const resumo = dash?.resumo || {};
  setText('#kpiVendas', money(resumo.vendasHoje));
  setText('#kpiTickets', resumo.ticketsHoje || 0);
  setText('#kpiImpostos', money(resumo.impostos30d));
  setText('#kpiDual', money(resumo.cbsIbs30d));
  setText('#kpiPendentes', money(resumo.valorPendente || dash?.pagamentosPendentes?.valor));
  setText('#kpiPendentesQtd', resumo.pagamentosPendentes || dash?.pagamentosPendentes?.quantidade || 0);
  setText('#kpiLeads', resumo.leads || 0);
  setText('#kpiWa', dash?.whatsapp?.conversas || 0);
  setText('#kpiWaUnread', dash?.whatsapp?.nao_lidas || 0);
  setText('#kpiWaAi', dash?.whatsapp?.com_ia || 0);
  setText('#heroRevenue', money(resumo.vendasHoje));
  setText('#heroOrders', resumo.ticketsHoje || 0);
  setText('#heroTicket', money(resumo.ticketMedio));
  const serie = Array.isArray(dash?.serie14d) ? dash.serie14d : [];
  renderChart('#chart14', serie, { gradientId: 'chart14Grad' });
  const total = serie.reduce((sum, item) => sum + Number(item.total || 0), 0);
  setText('#chartTotal', money(total));
  const labels = $('#chartLabels');
  if (labels) {
    labels.innerHTML = serie
      .map((item, index) => (index % 2 === 0 ? `<span>${esc(fmtShortDay(item.data))}</span>` : '<span></span>'))
      .join('');
  }
  renderSpark(serie);
  const salesBody = $('#latestSales');
  if (salesBody) {
    const rows = (dash?.ultimasVendas || []).slice(0, 8);
    salesBody.innerHTML = rows.length
      ? rows
          .map(
            (sale) => `<tr>
              <td><strong>${esc(sale.numero || `#${sale.id}`)}</strong></td>
              <td>${esc(sale.cliente_nome || 'Consumidor')}</td>
              <td>${money(sale.total)}</td>
              <td class="mono">${money(sale.impostos)}</td>
              <td>${esc(fmtDateTime(sale.data))}</td>
            </tr>`
          )
          .join('')
      : emptyRow(5, 'Nenhuma venda registrada ainda.');
  }
  const lowList = $('#lowStockList');
  if (lowList) {
    const items = dash?.baixoEstoque || [];
    lowList.innerHTML = items.length
      ? items
          .slice(0, 6)
          .map(
            (item) => `<div class="low-stock-item"><strong>${esc(item.nome)}</strong><span>${Number(item.estoque) || 0} un.</span></div>`
          )
          .join('')
      : '<p class="muted small">Nenhum item crítico.</p>';
  }
  updateNavBadges();
}
function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function renderSpark(serie) {
  const line = $('#heroSparkLine');
  const fill = $('#heroSparkFill');
  if (!line || !fill || !serie.length) return;
  const values = serie.map((item) => Number(item.total || 0));
  const max = Math.max(...values, 1);
  const step = 260 / Math.max(values.length - 1, 1);
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(44 - (value / max) * 38).toFixed(1)}`);
  line.setAttribute('d', `M${points.join(' L')}`);
  fill.setAttribute('d', `M0,48 L${points.join(' L')} L260,48 Z`);
}

function renderChart(selector, data, { gradientId = 'chartGrad' } = {}) {
  const svg = $(selector);
  if (!svg) return;
  if (!data.length) {
    svg.innerHTML = '<text x="320" y="110" text-anchor="middle" fill="#8b867a" font-size="12">Sem dados no período</text>';
    return;
  }
  const width = 640;
  const height = 220;
  const padding = { left: 12, right: 12, top: 18, bottom: 18 };
  const values = data.map((item) => Number(item.total || 0));
  const max = Math.max(...values, 1);
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const step = innerW / Math.max(data.length - 1, 1);
  const points = values.map((value, index) => ({
    x: padding.left + index * step,
    y: padding.top + innerH - (value / max) * innerH,
  }));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${height - padding.bottom} L${points[0].x.toFixed(1)},${height - padding.bottom} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padding.top + innerH * ratio;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(120,100,70,.12)" stroke-width="1"/>`;
    })
    .join('');
  const dots = points
    .map(
      (point, index) =>
        `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.2" fill="#ff7a1a" opacity="${index === points.length - 1 ? 1 : 0.35}"><title>${esc(fmtShortDay(data[index].data))}: ${money(data[index].total)}</title></circle>`
    )
    .join('');
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,138,46,.30)"/>
        <stop offset="100%" stop-color="rgba(255,138,46,0)"/>
      </linearGradient>
      <linearGradient id="${gradientId}-line" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#ff7a1a"/>
        <stop offset="60%" stop-color="#ff9a4d"/>
        <stop offset="100%" stop-color="#4a8bff"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaPath}" fill="url(#${gradientId})"/>
    <path d="${linePath}" fill="none" stroke="url(#${gradientId}-line)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  `;
}

/* ── render: PDV & products ────────────────────────────── */
function productFilter(term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return S.products;
  return S.products.filter((product) =>
    [product.nome, product.sku, product.barras, product.ncm].some((value) =>
      String(value || '').toLowerCase().includes(needle)
    )
  );
}
function renderPdvProducts() {
  const container = $('#pdvProducts');
  if (!container) return;
  const term = $('#pdvSearch')?.value || '';
  const products = productFilter(term);
  if (!products.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><svg><use href="#i-box"/></svg><h3>Nenhum produto encontrado</h3><p>${S.products.length ? 'Tente outro termo ou leia o código de barras.' : 'Cadastre produtos para começar a vender.'}</p></div>`;
    return;
  }
  container.innerHTML = products
    .slice(0, 120)
    .map((product) => {
      const stock = Number(product.estoque) || 0;
      const out = stock <= 0;
      return `<button type="button" class="product-card ${out ? 'out' : ''}" data-action="add-to-cart" data-sku="${esc(product.sku)}" ${out ? 'disabled' : ''}>
        <div class="p-emoji"><svg><use href="#i-box"/></svg></div>
        <span class="p-name">${esc(product.nome)}</span>
        <span class="p-sku">${esc(product.sku)}${product.barras ? ` · ${esc(product.barras)}` : ''}</span>
        <div class="p-foot"><span class="p-price">${money(product.preco)}</span><span class="p-stock ${stock <= 5 ? 'low' : ''}">${stock} un.</span></div>
        <span class="p-add"><svg><use href="#${out ? 'i-close' : 'i-plus'}"/></svg></span>
      </button>`;
    })
    .join('');
}

function addToCart(sku) {
  const product = S.products.find((item) => item.sku === sku);
  if (!product) return toast('Produto não encontrado.', 'err');
  const stock = Number(product.estoque) || 0;
  const line = S.cart.find((item) => item.sku === sku);
  const nextQuantity = (line?.qtd || 0) + 1;
  if (nextQuantity > stock) {
    return toast(`Estoque insuficiente para ${product.nome} (disponível: ${stock}).`, 'err');
  }
  if (line) line.qtd = nextQuantity;
  else {
    S.cart.push({
      sku: product.sku,
      nome: product.nome,
      preco: numberValue(product.preco),
      icms: numberValue(product.icms ?? 18),
      ncm: product.ncm || '',
      cfop: product.cfop || '5102',
      qtd: 1,
      estoque: stock,
    });
  }
  renderCart();
  toast(`${product.nome} adicionado.`, 'ok', 1500);
}

function cartLineTaxes(line) {
  const total = round2(line.preco * line.qtd);
  const icms = round2(total * (line.icms / 100));
  const pis = round2(total * 0.0165);
  const cofins = round2(total * 0.076);
  const cbs = round2(total * 0.009);
  const ibs = round2(total * 0.001);
  return { total, icms, pis, cofins, cbs, ibs, legacy: round2(icms + pis + cofins), dual: round2(cbs + ibs) };
}
function cartTotals() {
  return S.cart.reduce(
    (acc, line) => {
      const tax = cartLineTaxes(line);
      acc.subtotal += tax.total;
      acc.tax += tax.legacy;
      acc.dual += tax.dual;
      acc.count += line.qtd;
      return acc;
    },
    { subtotal: 0, tax: 0, dual: 0, count: 0 }
  );
}
function renderCart() {
  const container = $('#cartItems');
  if (!container) return;
  if (!S.cart.length) {
    container.innerHTML = `<div class="empty-state small"><svg><use href="#i-cart"/></svg><p>Adicione produtos para começar.</p></div>`;
  } else {
    container.innerHTML = S.cart
      .map(
        (line) => {
          const tax = cartLineTaxes(line);
          return `<div class="cart-line">
            <div><div class="ci-name">${esc(line.nome)}</div><div class="ci-meta">${esc(line.sku)} · ${money(line.preco)} / un.</div></div>
            <div class="ci-price">${money(tax.total)}</div>
            <div class="ci-controls">
              <div class="qty-control"><button type="button" data-action="cart-dec" data-sku="${esc(line.sku)}" aria-label="Diminuir">−</button><span>${line.qtd}</span><button type="button" data-action="cart-inc" data-sku="${esc(line.sku)}" aria-label="Aumentar">+</button></div>
              <button type="button" class="ci-remove" data-action="cart-remove" data-sku="${esc(line.sku)}" aria-label="Remover"><svg><use href="#i-trash"/></svg></button>
            </div>
          </div>`;
        }
      )
      .join('');
  }
  const totals = cartTotals();
  setText('#cartCount', totals.count);
  setText('#cartSubtotal', money(round2(totals.subtotal)));
  setText('#cartTax', money(round2(totals.tax)));
  setText('#cartDual', money(round2(totals.dual)));
  setText('#cartTotal', money(round2(totals.subtotal)));
  const button = $('#finalizeBtn');
  if (button) button.disabled = !S.cart.length;
}
function changeCartQty(sku, delta) {
  const line = S.cart.find((item) => item.sku === sku);
  if (!line) return;
  if (delta > 0 && line.qtd >= line.estoque) {
    toast(`Estoque máximo de ${line.nome}: ${line.estoque}.`, 'err');
    return;
  }
  line.qtd += delta;
  if (line.qtd <= 0) S.cart = S.cart.filter((item) => item.sku !== sku);
  renderCart();
}
function clearCart(silent = false) {
  S.cart = [];
  renderCart();
  if (!silent) toast('Carrinho limpo.', 'info', 1600);
}

async function finalizeSale() {
  if (!S.cart.length) return toast('Adicione pelo menos um produto.', 'err');
  const button = $('#finalizeBtn');
  const paymentMethod = $('#salePayment')?.value || 'pix_auto';
  const clienteNome = $('#saleClientName')?.value.trim() || '';
  const clienteTel = digits($('#saleClientTel')?.value || '');
  const payload = {
    clientId: uid(),
    numero: `PDV-${Date.now().toString(36).toUpperCase()}`,
    data: new Date().toISOString(),
    clienteNome,
    clienteTel,
    detalhe: S.cart.map((line) => ({
      sku: line.sku,
      nome: line.nome,
      qtd: line.qtd,
      preco: line.preco,
      icms: line.icms,
      ncm: line.ncm,
      cfop: line.cfop,
    })),
  };
  busy(button, true, 'Registrando…');
  let sale;
  try {
    sale = await api('/api/vendas', { method: 'POST', body: payload });
  } catch (error) {
    if (error.code === 'NETWORK') {
      enqueueSale(payload, paymentMethod);
      clearCart(true);
      ['saleClientName', 'saleClientTel', 'saleClientDoc'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      toast('Sem conexão: venda guardada na fila offline e será sincronizada.', 'info', 6000);
      loadDashboardPage();
      busy(button, false);
      return;
    }
    busy(button, false);
    toast(`Venda não registrada: ${error.message}`, 'err', 6000);
    return;
  }
  const total = numberValue(sale.total);
  clearCart(true);
  ['saleClientName', 'saleClientTel', 'saleClientDoc'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  toast(`Venda ${sale.numero || 'registrada'} concluída: ${money(total)}.`, 'ok', 5000);
  localStorage.removeItem('noxmob.lastSaleId');
  safeSet('noxmob.lastSale', {
    id: sale.vendaId,
    numero: sale.numero,
    total,
    cliente: clienteNome,
    itens: payload.detalhe,
    data: payload.data,
    pagamento: paymentMethod,
  });
  if (paymentMethod !== 'dinheiro') {
    try {
      const result = await createPaymentForSale(paymentMethod, {
        vendaId: sale.vendaId,
        valor: total,
        descricao: `Venda ${sale.numero || sale.vendaId} · NoxMob`,
        clienteNome,
        clienteTelefone: clienteTel,
      });
      showPaymentResult(result, 'Cobrança da venda');
      loadPayments();
    } catch (error) {
      toast(`Venda registrada. Cobrança não gerada: ${error.message}`, 'err', 7000);
    }
  } else {
    showReceiptPrompt({ id: sale.vendaId, numero: sale.numero, total, cliente: clienteNome, itens: payload.detalhe, data: payload.data });
  }
  busy(button, false);
  loadSync();
  loadDashboardPage();
}

function enqueueSale(payload, paymentMethod) {
  const queue = safeJson(QUEUE_KEY, []);
  queue.push({ payload, paymentMethod, criadoEm: new Date().toISOString() });
  safeSet(QUEUE_KEY, queue);
  updateQueueBadge();
}
async function syncQueue() {
  if (S.queueSyncing || !S.token) return;
  const queue = safeJson(QUEUE_KEY, []);
  if (!queue.length) return;
  if (!navigator.onLine) return;
  S.queueSyncing = true;
  const remaining = [];
  let synced = 0;
  for (const item of queue) {
    try {
      const sale = await api('/api/vendas', { method: 'POST', body: item.payload });
      synced += 1;
      if (item.paymentMethod && item.paymentMethod !== 'dinheiro') {
        try {
          await createPaymentForSale(item.paymentMethod, {
            vendaId: sale.vendaId,
            valor: sale.total,
            descricao: `Venda offline ${sale.numero || sale.vendaId}`,
          });
        } catch {
          /* cobrança pode ser gerada manualmente depois */
        }
      }
    } catch (error) {
      if (error.code === 'NETWORK') {
        remaining.push(item, ...queue.slice(queue.indexOf(item) + 1));
        break;
      }
      toast(`Venda offline rejeitada: ${error.message}`, 'err', 7000);
    }
  }
  safeSet(QUEUE_KEY, remaining);
  S.queueSyncing = false;
  updateQueueBadge();
  if (synced) {
    toast(`${synced} venda(s) offline sincronizada(s).`, 'ok', 5000);
    loadSync();
    loadDashboardPage();
  }
}
function updateQueueBadge() {
  const queue = safeJson(QUEUE_KEY, []);
  const badge = $('#offlineQueueBadge');
  if (badge) {
    badge.hidden = !queue.length;
    badge.textContent = `${queue.length} na fila`;
  }
  setText('#sysQueue', `${queue.length} venda(s)`);
}

function renderProducts() {
  const body = $('#productsBody');
  if (!body) return;
  const term = ($('#productSearch')?.value || '').toLowerCase();
  const products = productFilter(term);
  setText('#productCount', `${products.length} item(ns)`);
  if (!products.length) {
    body.innerHTML = emptyRow(7, S.products.length ? 'Nenhum produto corresponde à busca.' : 'Nenhum produto cadastrado.');
    return;
  }
  body.innerHTML = products
    .slice(0, 500)
    .map(
      (product) => `<tr>
        <td><strong>${esc(product.nome)}</strong>${product.barras ? `<div class="hint">${esc(product.barras)}</div>` : ''}</td>
        <td class="mono">${esc(product.sku)}</td>
        <td>${money(product.preco)}</td>
        <td><span class="${Number(product.estoque) <= 5 ? 'pill pill-amber' : ''}">${Number(product.estoque) || 0}</span></td>
        <td>${Number(product.icms ?? 18).toFixed(0)}%</td>
        <td class="mono">${esc(product.ncm || '—')} · ${esc(product.cfop || '5102')}</td>
        <td><div class="table-actions">
          <button type="button" data-action="edit-product" data-sku="${esc(product.sku)}" title="Editar"><svg><use href="#i-edit"/></svg></button>
          ${canManage() ? `<button type="button" class="danger" data-action="delete-product" data-sku="${esc(product.sku)}" title="Excluir"><svg><use href="#i-trash"/></svg></button>` : ''}
        </div></td>
      </tr>`
    )
    .join('');
}

function renderStock() {
  const products = S.products;
  const units = products.reduce((sum, product) => sum + (Number(product.estoque) || 0), 0);
  const value = products.reduce((sum, product) => sum + (Number(product.estoque) || 0) * numberValue(product.preco), 0);
  const critical = products.filter((product) => Number(product.estoque) <= 5);
  setText('#stockSkus', products.length);
  setText('#stockUnits', units);
  setText('#stockValue', money(value));
  setText('#stockCritical', critical.length);
  setText('#lowStockCount', `${critical.length} item(ns)`);
  const body = $('#lowStockBody');
  if (!body) return;
  body.innerHTML = critical.length
    ? critical
        .sort((a, b) => Number(a.estoque) - Number(b.estoque))
        .slice(0, 80)
        .map(
          (product) => `<tr>
            <td><strong>${esc(product.nome)}</strong></td>
            <td class="mono">${esc(product.sku)}</td>
            <td><span class="pill ${Number(product.estoque) <= 0 ? 'pill-rose' : 'pill-amber'}">${Number(product.estoque) || 0}</span></td>
            <td>${money(product.preco)}</td>
            <td><div class="table-actions"><button type="button" data-action="edit-product" data-sku="${esc(product.sku)}" title="Repor / editar"><svg><use href="#i-edit"/></svg></button></div></td>
          </tr>`
        )
        .join('')
    : emptyRow(5, 'Nenhum item crítico. Estoque saudável.');
  updateNavBadges();
}

/* ── render: people & leads ────────────────────────────── */
function renderPeople() {
  const body = $('#peopleBody');
  setText('#peopleCount', S.people.length);
  setText('#leadsCount', S.leads.length);
  if (!body) return;
  body.innerHTML = S.people.length
    ? S.people
        .map(
          (person) => `<tr>
            <td><strong>${esc(person.nome)}</strong></td>
            <td class="mono">${esc(person.doc || '—')}</td>
            <td><span class="pill pill-slate">${esc(person.tipo || 'PF')}</span></td>
            <td class="mono">${esc(person.tel || '—')}</td>
            <td>${esc(person.email || '—')}</td>
            <td><div class="table-actions">
              ${person.tel ? `<button type="button" class="wa" data-action="wa-person" data-tel="${esc(person.tel)}" data-nome="${esc(person.nome)}" data-doc="${esc(person.doc || '')}" title="WhatsApp"><svg><use href="#i-chat"/></svg></button>` : ''}
              <button type="button" data-action="edit-person" data-id="${Number(person.id)}" title="Editar"><svg><use href="#i-edit"/></svg></button>
              ${canManage() ? `<button type="button" class="danger" data-action="delete-person" data-id="${Number(person.id)}" title="Excluir"><svg><use href="#i-trash"/></svg></button>` : ''}
            </div></td>
          </tr>`
        )
        .join('')
    : emptyRow(6, 'Nenhuma pessoa cadastrada.');
  renderLeads();
}
function renderLeads() {
  const body = $('#leadsBody');
  if (!body) return;
  body.innerHTML = S.leads.length
    ? S.leads
        .map(
          (lead) => `<tr>
            <td><strong>${esc(lead.nome || 'Cliente')}</strong><div class="hint">${esc(lead.doc || '')}</div></td>
            <td class="mono">${esc(lead.tel || '—')}</td>
            <td>${Number(lead.compras) || 0}</td>
            <td>${esc(fmtDateTime(lead.ultima_compra))}</td>
            <td>${money(lead.valor)}</td>
            <td><div class="table-actions">
              ${lead.tel ? `<button type="button" class="wa" data-action="wa-person" data-tel="${esc(lead.tel)}" data-nome="${esc(lead.nome || '')}" title="WhatsApp"><svg><use href="#i-chat"/></svg></button>` : ''}
            </div></td>
          </tr>`
        )
        .join('')
    : emptyRow(6, 'Nenhum lead ainda. As vendas com WhatsApp criam leads automaticamente.');
}

/* ── render: hotel / frigobar ──────────────────────────── */
function renderGuests() {
  const body = $('#guestsBody');
  if (!body) return;
  body.innerHTML = S.guests.length
    ? S.guests
        .map(
          (guest) => `<tr>
            <td><strong>${esc(guest.nome)}</strong><div class="hint">${esc(guest.doc || '')}</div></td>
            <td><span class="pill pill-blue">${esc(guest.quarto)}</span></td>
            <td>${esc(fmtDateTime(guest.checkin))}</td>
            <td>${statusPill(guest.status === 'ocupado' ? 'ativo' : guest.status)}</td>
            <td class="mono">${esc(guest.tel || '—')}</td>
          </tr>`
        )
        .join('')
    : emptyRow(5, 'Nenhum hóspede ativo.');
}
function renderConsumos() {
  const body = $('#consumosBody');
  const today = new Date().toISOString().slice(0, 10);
  const todayTotal = S.consumos
    .filter((item) => String(item.criado_em || '').slice(0, 10) === today)
    .reduce((sum, item) => sum + numberValue(item.valor), 0);
  setText('#consumoToday', `Hoje: ${money(todayTotal)}`);
  if (!body) return;
  body.innerHTML = S.consumos.length
    ? S.consumos
        .map(
          (item) => `<tr>
            <td class="mono">#${Number(item.id)}</td>
            <td><span class="pill pill-blue">${esc(item.quarto)}</span></td>
            <td>${esc(item.nome || '—')}</td>
            <td>${esc(item.descricao)}</td>
            <td>${money(item.valor)}</td>
            <td>${statusPill(item.status === 'pago' ? 'pago' : item.status === 'pendente' ? 'pendente' : item.status)}</td>
            <td>${esc(fmtDateTime(item.criado_em))}</td>
          </tr>`
        )
        .join('')
    : emptyRow(7, 'Nenhum consumo registrado.');
}
function renderFrigo() {
  setText('#frigoCount', `${S.frigo.length} item(ns)`);
  const body = $('#frigoBody');
  if (!body) return;
  body.innerHTML = S.frigo.length
    ? S.frigo
        .map((item) => {
          const low = Number(item.estoque) <= Number(item.estoque_minimo || 3);
          return `<tr>
            <td><strong>${esc(item.nome)}</strong></td>
            <td class="mono">${esc(item.sku)}</td>
            <td>${money(item.preco)}</td>
            <td><span class="pill ${Number(item.estoque) <= 0 ? 'pill-rose' : low ? 'pill-amber' : 'pill-mint'}">${Number(item.estoque) || 0}</span></td>
            <td>${Number(item.estoque_minimo) || 0}</td>
            <td>${low ? '<span class="pill pill-amber">Repor</span>' : '<span class="pill pill-mint">OK</span>'}</td>
            <td><div class="table-actions">
              <button type="button" data-action="replenish-frigo-item" data-sku="${esc(item.sku)}" title="Repor"><svg><use href="#i-plus"/></svg></button>
              ${canManage() ? `<button type="button" data-action="edit-frigo" data-sku="${esc(item.sku)}" title="Editar"><svg><use href="#i-edit"/></svg></button>` : ''}
            </div></td>
          </tr>`;
        })
        .join('')
    : emptyRow(7, 'Nenhum item de frigobar cadastrado.');
}
function renderChargeItems() {
  const container = $('#chargeItems');
  if (!container) return;
  if (!S.frigo.length) {
    container.innerHTML = '<p class="muted small">Nenhum item disponível.</p>';
    updateChargeTotal();
    return;
  }
  container.innerHTML = S.frigo
    .filter((item) => item.ativo !== 0)
    .map(
      (item) => `<label class="charge-item">
        <input type="checkbox" data-charge-sku="${esc(item.sku)}" data-price="${Number(item.preco) || 0}"/>
        <span class="ci-title">${esc(item.nome)}</span>
        <span class="ci-tag">${money(item.preco)}</span>
        <input type="number" min="1" max="99" value="1" data-charge-qty="${esc(item.sku)}" aria-label="Quantidade"/>
      </label>`
    )
    .join('');
  updateChargeTotal();
}
function updateChargeTotal() {
  let total = 0;
  $$('#chargeItems input[type="checkbox"]:checked').forEach((checkbox) => {
    const sku = checkbox.dataset.chargeSku;
    const qtyInput = $(`#chargeItems input[data-charge-qty="${CSS.escape(sku)}"]`);
    const qty = Math.max(1, Number(qtyInput?.value) || 1);
    total += numberValue(checkbox.dataset.price) * qty;
  });
  setText('#chargeTotal', money(total));
}
function chargeSelections() {
  const items = [];
  $$('#chargeItems input[type="checkbox"]:checked').forEach((checkbox) => {
    const sku = checkbox.dataset.chargeSku;
    const qtyInput = $(`#chargeItems input[data-charge-qty="${CSS.escape(sku)}"]`);
    items.push({ sku, quantidade: Math.max(1, Number(qtyInput?.value) || 1) });
  });
  return items;
}

/* ── render: dashboard badges ──────────────────────────── */
function updateNavBadges() {
  const low = S.products.filter((product) => Number(product.estoque) <= 5).length;
  const lowBadge = $('#navLowStock');
  if (lowBadge) {
    lowBadge.hidden = !low;
    lowBadge.textContent = low;
  }
  const unread = S.dashboard?.whatsapp?.nao_lidas ?? S.wa.conversations.reduce((sum, conv) => sum + (Number(conv.nao_lidas) || 0), 0);
  const unreadBadge = $('#navUnread');
  if (unreadBadge) {
    unreadBadge.hidden = !unread;
    unreadBadge.textContent = unread;
  }
}

/* ── render: reports & fiscal ──────────────────────────── */
function salesForPeriod(days) {
  if (!days) return S.sales;
  const cutoff = Date.now() - days * 86400000;
  return S.sales.filter((sale) => {
    const date = parseDate(sale.data || sale.criado_em);
    return date ? date.getTime() >= cutoff : false;
  });
}
function renderReports() {
  const sales = salesForPeriod(S.period);
  const revenue = sales.reduce((sum, sale) => sum + numberValue(sale.total), 0);
  const tax = sales.reduce((sum, sale) => sum + numberValue(sale.impostos), 0);
  const dual = sales.reduce((sum, sale) => sum + numberValue(sale.cbs_ibs), 0);
  const net = Math.max(0, revenue - tax - dual);
  const ticket = sales.length ? revenue / sales.length : 0;
  setText('#reportRevenue', money(revenue));
  setText('#reportTax', money(tax));
  setText('#reportNet', money(net));
  setText('#reportTicket', money(ticket));
  setText('#reportOrders', sales.length);
  setText('#reportPeriodLabel', S.period ? `últimos ${S.period} dias` : 'todo o histórico');

  const grouped = new Map();
  sales.forEach((sale) => {
    const key = dayKey(sale.data || sale.criado_em);
    grouped.set(key, round2((grouped.get(key) || 0) + numberValue(sale.total)));
  });
  const series = Array.from(grouped.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([data, total]) => ({ data, total }));
  renderChart('#reportChart', series, { gradientId: 'reportGrad' });

  const dre = $('#dreRows');
  if (dre) {
    const itens = sales.reduce((sum, sale) => sum + (Array.isArray(sale.detalhe) ? sale.detalhe.reduce((sub, item) => sub + (Number(item.qtd) || 0), 0) : 0), 0);
    dre.innerHTML = `
      <div class="dre-row"><span>Receita bruta</span><strong>${money(revenue)}</strong></div>
      <div class="dre-row negative"><span>Impostos legados (ICMS/PIS/COFINS)</span><strong>− ${money(tax)}</strong></div>
      <div class="dre-row negative"><span>CBS + IBS</span><strong>− ${money(dual)}</strong></div>
      <div class="dre-row"><span>Receita líquida estimada</span><strong>${money(net)}</strong></div>
      <div class="dre-row"><span>Vendas / itens</span><strong>${sales.length} / ${itens}</strong></div>
      <div class="dre-row total"><span>Ticket médio</span><strong>${money(ticket)}</strong></div>
    `;
  }
  const body = $('#reportSalesBody');
  if (body) {
    body.innerHTML = sales.length
      ? sales
          .slice(0, 200)
          .map(
            (sale) => `<tr>
              <td><strong>${esc(sale.numero || `#${sale.id}`)}</strong></td>
              <td>${esc(fmtDateTime(sale.data || sale.criado_em))}</td>
              <td>${esc(sale.cliente_nome || 'Consumidor')}</td>
              <td>${Array.isArray(sale.detalhe) ? sale.detalhe.reduce((sum, item) => sum + (Number(item.qtd) || 0), 0) : 0}</td>
              <td>${money(sale.total)}</td>
              <td class="mono">${money(sale.impostos)}</td>
              <td class="mono">${money(sale.cbs_ibs)}</td>
            </tr>`
          )
          .join('')
      : emptyRow(7, 'Nenhuma venda no período.');
  }
}
function renderFiscal() {
  const sales = S.sales;
  const revenue = sales.reduce((sum, sale) => sum + numberValue(sale.total), 0);
  const dual = sales.reduce((sum, sale) => sum + numberValue(sale.cbs_ibs), 0);
  const cbs = round2(dual * (0.009 / 0.01));
  const ibs = round2(dual * (0.001 / 0.01));
  setText('#fiscalCbs', money(cbs));
  setText('#fiscalIbs', money(ibs));
  setText('#fiscalDual', money(dual));
  setText('#fiscalBase', money(revenue));
  const params = $('#fiscalParams');
  if (params) {
    params.innerHTML = `
      <div><span>ICMS por produto</span><strong>0% a 100%</strong></div>
      <div><span>PIS</span><strong>1,65%</strong></div>
      <div><span>COFINS</span><strong>7,60%</strong></div>
      <div><span>CBS</span><strong>0,90%</strong></div>
      <div><span>IBS</span><strong>0,10%</strong></div>
      <div><span>CFOP padrão</span><strong>5102</strong></div>
    `;
  }
  const cfopMap = new Map();
  sales.forEach((sale) => {
    if (!Array.isArray(sale.detalhe)) return;
    sale.detalhe.forEach((item) => {
      const cfop = item.cfop || '5102';
      const current = cfopMap.get(cfop) || { itens: 0, base: 0, dual: 0 };
      current.itens += Number(item.qtd) || 0;
      current.base += numberValue(item.total);
      current.dual += numberValue(item.impostos_novos?.cbs) + numberValue(item.impostos_novos?.ibs);
      cfopMap.set(cfop, current);
    });
  });
  const fiscalRows = $('#fiscalRows');
  if (fiscalRows) {
    fiscalRows.innerHTML = cfopMap.size
      ? Array.from(cfopMap.entries())
          .map(
            ([cfop, data]) => `<tr><td class="mono">${esc(cfop)}</td><td>${data.itens}</td><td>${money(data.base)}</td><td class="mono">${money(data.dual)}</td></tr>`
          )
          .join('')
      : emptyRow(4, 'Sem dados fiscais.');
  }
  const productsBody = $('#fiscalProducts');
  setText('#fiscalProductCount', `${S.products.length} SKUs`);
  if (productsBody) {
    productsBody.innerHTML = S.products.length
      ? S.products
          .slice(0, 200)
          .map(
            (product) => `<tr><td><strong>${esc(product.nome)}</strong></td><td class="mono">${esc(product.ncm || '—')}</td><td class="mono">${esc(product.cfop || '5102')}</td><td>${Number(product.icms ?? 18).toFixed(0)}%</td><td>${money(product.preco)}</td></tr>`
          )
          .join('')
      : emptyRow(5, 'Nenhum produto.');
  }
}

/* ── render: payments & providers ──────────────────────── */
function renderProviders() {
  const grid = $('#providerGrid');
  if (!grid) return;
  if (!S.providers) {
    grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
    return;
  }
  const p = S.providers;
  const data = [
    {
      key: 'asaas',
      name: 'Asaas',
      info: p.asaas?.ambiente ? `Ambiente: ${p.asaas.ambiente}` : 'PIX + checkout',
      tags: ['PIX', 'Checkout'],
      on: p.asaas?.configurado,
    },
    {
      key: 'inter',
      name: 'Banco Inter',
      info: p.inter?.mTLS ? 'PIX com mTLS ativo' : 'PIX via API Inter',
      tags: ['PIX'],
      on: p.inter?.configurado,
    },
    {
      key: 'upi',
      name: 'UPI · Google Pay',
      info: 'Índia · moeda INR',
      tags: ['UPI', 'Intent'],
      on: p.upi?.configurado,
    },
    {
      key: 'applepay',
      name: 'Apple Pay',
      info: p.applepay?.configurado ? 'Merchant validado' : 'Configurar Merchant ID',
      tags: ['Wallet'],
      on: p.applepay?.configurado,
    },
  ];
  grid.innerHTML = data
    .map(
      (item) => `<article class="provider-card">
        <div class="provider-card-head"><strong>${esc(item.name)}</strong><span class="pill ${item.on ? 'pill-mint' : 'pill-slate'}">${item.on ? 'Conectado' : 'Não configurado'}</span></div>
        <p class="provider-meta">${esc(item.info)}</p>
        <div class="provider-tags">${item.tags.map((tag) => `<span class="chip chip-xs">${esc(tag)}</span>`).join('')}</div>
      </article>`
    )
    .join('');
  const note = p.regra;
  if (note) {
    const last = grid.querySelectorAll('.provider-card');
    if (last.length) last[last.length - 1].title = note;
  }
}
function renderPayments() {
  setText('#paymentsCount', `${S.payments.length} cobrança(s)`);
  const body = $('#paymentsBody');
  if (!body) return;
  if (!S.payments.length) {
    body.innerHTML = emptyRow(7, 'Nenhuma cobrança gerada.');
    return;
  }
  body.innerHTML = S.payments
    .map((payment) => {
      const pending = payment.status === 'pendente';
      const external = payment.external_id || payment.txid || '';
      const link = payment.checkout_url || payment.qr_payload ? payment.checkout_url : '';
      let actions = '';
      if (pending && payment.provider === 'asaas' && external) {
        actions += `<button type="button" class="wa" data-action="payment-status" data-provider="asaas" data-external="${esc(external)}" title="Verificar status"><svg><use href="#i-refresh"/></svg></button>`;
      }
      if (pending && payment.provider === 'inter' && payment.txid) {
        actions += `<button type="button" class="wa" data-action="payment-status" data-provider="inter" data-external="${esc(payment.txid)}" title="Verificar status"><svg><use href="#i-refresh"/></svg></button>`;
      }
      if (pending && payment.provider === 'upi' && payment.txid && canManage()) {
        actions += `<button type="button" class="wa" data-action="payment-confirm-upi" data-txid="${esc(payment.txid)}" title="Confirmar UPI manualmente"><svg><use href="#i-check"/></svg></button>`;
      }
      if (link) {
        actions += `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Abrir checkout" style="display:inline-flex;width:27px;height:27px;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:7px;color:#7f9abb"><svg><use href="#i-arrow"/></svg></a>`;
      }
      return `<tr>
        <td class="mono">#${Number(payment.id)}</td>
        <td><span class="pill pill-blue">${esc(payment.provider)}</span></td>
        <td>${esc(payment.metodo)}</td>
        <td>${money(payment.valor)}</td>
        <td>${statusPill(payment.status)}</td>
        <td>${esc(fmtDateTime(payment.criado_em))}</td>
        <td><div class="table-actions">${actions || '<span class="hint">—</span>'}</div></td>
      </tr>`;
    })
    .join('');
}

/* ── render: WhatsApp ──────────────────────────────────── */
function renderWaStatus() {
  const strip = $('#waStatusStrip');
  if (!strip) return;
  const status = S.wa.status;
  if (!status) {
    strip.innerHTML = '<span class="chip">Verificando integrações…</span>';
    return;
  }
  const zernio = status.zernio || {};
  const ia = status.ia || {};
  const webhook = status.webhook || {};
  const stats = status.stats || {};
  const iaNome = ia.provedor === 'grok' ? 'Grok' : ia.provedor === 'workers-ai' ? 'Llama' : 'regras';
  strip.innerHTML = `
    <span class="chip ${zernio.configurado ? 'chip-mint' : 'chip-amber'}"><span class="pulse-dot"></span> Zernio ${zernio.configurado ? 'conectado' : 'pendente'}</span>
    <span class="chip ${webhook.configurado ? 'chip-mint' : 'chip-amber'}">Webhook ${webhook.configurado ? 'assinado' : 'sem secret'}</span>
    <span class="chip ${ia.configurada ? 'chip-mint' : 'chip-amber'}" title="${esc(ia.modelo || '')}">IA ${ia.configurada ? iaNome : 'regras'}</span>
    <span class="chip">${stats.conversas || 0} conversa(s)</span>
    <span class="chip">${stats.mensagens_hoje || 0} msg hoje</span>
    <span class="chip">${ia.ativa ? 'Automático ligado' : 'Automático pausado'}</span>
  `;
  const chip = $('#waIaChip');
  if (chip) {
    chip.textContent = ia.ativa ? 'IA ativa' : 'IA pausada';
    chip.className = `chip ${ia.ativa ? 'chip-mint' : 'chip-amber'}`;
  }
}
function renderWaConversations() {
  const container = $('#waConversations');
  if (!container) return;
  const term = ($('#waSearch')?.value || '').toLowerCase();
  const conversations = S.wa.conversations.filter((conversation) =>
    [conversation.nome, conversation.contato, conversation.ultima_mensagem].some((value) =>
      String(value || '').toLowerCase().includes(term)
    )
  );
  if (!conversations.length) {
    container.innerHTML = `<div class="empty-state small"><svg><use href="#i-chat"/></svg><p>${S.wa.conversations.length ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ainda. Sincronize o Zernio ou inicie um contato.'}</p></div>`;
    return;
  }
  container.innerHTML = conversations
    .map((conversation) => {
      const id = conversation.conversation_id;
      const active = S.wa.active?.conversation_id === id;
      const unread = Number(conversation.nao_lidas) || 0;
      return `<button type="button" class="wa-conv ${active ? 'active' : ''}" data-action="wa-open" data-id="${esc(id)}">
        <span class="wa-conv-avatar">${esc(initials(conversation.nome || conversation.contato || 'WA'))}</span>
        <span class="wa-conv-body">
          <strong>${esc(conversation.nome || conversation.contato || 'Contato')}${Number(conversation.ia_ativa) ? '<span class="ai-dot" title="IA ativa"></span>' : ''}</strong>
          <span>${esc(conversation.ultima_mensagem || 'Sem mensagens')}</span>
        </span>
        <span class="wa-conv-meta"><time>${esc(fmtTime(conversation.ultima_em || conversation.atualizado_em))}</time>${unread ? `<span class="wa-unread">${unread}</span>` : ''}</span>
      </button>`;
    })
    .join('');
}
function renderWaMessages() {
  const container = $('#waMessages');
  if (!container) return;
  if (!S.wa.active) {
    container.innerHTML = `<div class="empty-state"><svg><use href="#i-chat"/></svg><h3>Selecione uma conversa</h3><p>Responda pelo painel ou deixe a IA conduzir o primeiro atendimento.</p></div>`;
    return;
  }
  if (!S.wa.messages.length) {
    container.innerHTML = `<div class="empty-state small"><svg><use href="#i-chat"/></svg><p>Nenhuma mensagem registrada nesta conversa.</p></div>`;
    return;
  }
  let lastDay = '';
  container.innerHTML = S.wa.messages
    .map((message) => {
      const day = dayKey(message.criado_em);
      const separator = day !== lastDay ? `<div class="wa-day">${esc(fmtDate(message.criado_em))}</div>` : '';
      lastDay = day;
      const out = message.direcao === 'out';
      const origin = message.origem === 'ia' ? 'IA' : message.origem === 'humano' ? 'Você' : '';
      return `${separator}<div class="wa-msg ${out ? 'out' : 'in'}">${origin && out ? `<span class="origin">${esc(origin)}</span>` : ''}${esc(message.texto || '')}<span class="meta">${esc(fmtTime(message.criado_em))}${message.status ? ` · ${esc(message.status)}` : ''}</span></div>`;
    })
    .join('');
  container.scrollTop = container.scrollHeight;
}
function renderWaHeader() {
  const active = S.wa.active;
  const title = $('#waChatTitle');
  const sub = $('#waChatSub');
  const avatar = $('#waChatAvatar');
  const input = $('#waInput');
  const send = $('#waSendBtn');
  if (title) title.textContent = active ? active.nome || active.contato || 'Conversa' : 'Selecione uma conversa';
  if (sub) sub.textContent = active ? `${active.contato || ''}${active.ia_ativa ? ' · IA ativa' : ' · IA pausada'}` : 'Mensagens sincronizadas com o Zernio';
  if (avatar) avatar.textContent = active ? initials(active.nome || active.contato || 'WA') : '?';
  if (input) input.disabled = !active;
  if (send) send.disabled = !active;
}
function renderWaConfig() {
  const config = S.wa.config;
  if (!config) return;
  const fill = (id, value) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value ?? '';
  };
  fill('waNomeEmpresa', config.nome_empresa || '');
  fill('waHorario', config.horario || '');
  fill('waAccountId', config.account_id || '');
  fill('waProfileId', config.profile_id || '');
  fill('waPrompt', config.prompt_sistema || '');
  fill('waWelcome', config.mensagem_boas_vindas || '');
  fill('waOffHours', config.mensagem_fora_horario || '');
  const active = $('#waIaAtiva');
  if (active) active.checked = Number(config.ia_ativa) !== 0;
}

async function selectConversation(id) {
  const activeConversation = S.wa.conversations.find((conversation) => conversation.conversation_id === id);
  S.wa.active = activeConversation || { conversation_id: id, nome: '', contato: '' };
  S.wa.messages = [];
  renderWaHeader();
  renderWaConversations();
  renderWaMessages();
  try {
    const data = await api(`/api/wa/conversations/${encodeURIComponent(id)}`);
    S.wa.active = data.conversa;
    S.wa.messages = data.mensagens || [];
    renderWaHeader();
    renderWaMessages();
    const inList = S.wa.conversations.find((conversation) => conversation.conversation_id === id);
    if (inList) inList.nao_lidas = 0;
    renderWaConversations();
    api(`/api/wa/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {});
    updateNavBadges();
  } catch (error) {
    toast(`Conversa: ${error.message}`, 'err');
  }
}
async function reloadActiveConversation(silent = false) {
  const active = S.wa.active;
  if (!active) return;
  try {
    const data = await api(`/api/wa/conversations/${encodeURIComponent(active.conversation_id)}`);
    S.wa.active = data.conversa;
    S.wa.messages = data.mensagens || [];
    renderWaHeader();
    renderWaMessages();
    if (!silent) renderWaConversations();
  } catch {
    /* silencioso no polling */
  }
}
async function sendWhatsAppMessage() {
  const input = $('#waInput');
  const text = input?.value.trim();
  if (!S.wa.active || !text) return;
  const button = $('#waSendBtn');
  button.disabled = true;
  try {
    const data = await api(`/api/wa/conversations/${encodeURIComponent(S.wa.active.conversation_id)}/messages`, {
      method: 'POST',
      body: { text },
    });
    input.value = '';
    if (data?.ok === false) {
      toast(data.erro || 'Envio pelo provedor falhou.', 'err');
      if (data.waMe) openExternal(data.waMe);
    } else {
      toast('Mensagem enviada.', 'ok', 2200);
    }
    await reloadActiveConversation();
    await loadWaConversationsOnly();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = !S.wa.active;
  }
}
function startWaTimer() {
  stopWaTimer();
  S.waTimer = setInterval(() => {
    if (document.hidden || S.page !== 'whatsapp') return;
    loadWaConversationsOnly();
    if (S.wa.active) reloadActiveConversation(true);
  }, 25000);
}
function stopWaTimer() {
  if (S.waTimer) clearInterval(S.waTimer);
  S.waTimer = null;
}

/* ── render: users / health / config ───────────────────── */
function renderUsers(users) {
  S.users = Array.isArray(users) ? users : S.users;
  const query = ($('#userSearch')?.value || '').trim().toLowerCase();
  const filtered = query
    ? S.users.filter((user) =>
        [user.nome, user.email, user.doc, user.tipo, user.papel, user.status]
          .some((value) => String(value || '').toLowerCase().includes(query))
      )
    : S.users;
  setText('#usersCount', `${S.users.length} acesso(s)`);
  const filteredChip = $('#usersFiltered');
  if (filteredChip) {
    filteredChip.hidden = !query;
    filteredChip.textContent = `${filtered.length} exibido(s)`;
  }
  const body = $('#usersBody');
  if (!body) return;
  body.innerHTML = filtered.length
    ? filtered
        .map((user) => {
          const roleSelect = `<select data-action="user-role" data-email="${esc(user.email)}" ${user.email === S.user?.email ? 'disabled' : ''} style="min-width:95px;padding:5px 26px 5px 8px;font-size:10px">
            ${['admin', 'gerente', 'operador'].map((role) => `<option value="${role}" ${user.papel === role ? 'selected' : ''}>${role}</option>`).join('')}
          </select>`;
          const docCell = user.doc
            ? `<span class="doc-chip"><svg><use href="#i-id"/></svg>${esc(fmtDoc(user.doc))}</span><div class="hint">${esc(user.tipo || docType(user.doc) || 'DOC')}</div>`
            : '<span class="doc-chip off">não vinculado</span>';
          const accessCell = `<div class="access-cell">${esc(user.ultimo_acesso ? fmtDateTime(user.ultimo_acesso) : 'Nunca acessou')}<small>${Number(user.sessoes_ativas) || 0} sessão(ões)${user.ultimo_ip ? ` · ${esc(user.ultimo_ip)}` : ''}</small></div>`;
          return `<tr>
            <td><strong>${esc(user.nome)}</strong><div class="hint">${esc(user.email)}</div></td>
            <td>${docCell}</td>
            <td>${roleSelect}</td>
            <td>${statusPill(user.status === 'ativo' ? 'ativo' : user.status === 'pendente' ? 'pendente_aprovacao' : user.status)}</td>
            <td>${accessCell}</td>
            <td><div class="table-actions">
              ${user.doc ? `<button type="button" data-action="user-track" data-doc="${esc(user.doc)}" title="Rastrear acessos deste CPF/CNPJ" aria-label="Rastrear acessos"><svg><use href="#i-clock"/></svg></button>` : ''}
              <button type="button" class="orange" data-action="user-doc" data-email="${esc(user.email)}" data-doc="${esc(user.doc || '')}" title="${user.doc ? 'Alterar CPF/CNPJ' : 'Vincular CPF/CNPJ'}" aria-label="Vincular CPF/CNPJ"><svg><use href="#i-id"/></svg></button>
              ${user.status === 'pendente' ? `<button type="button" class="wa" data-action="user-approve" data-email="${esc(user.email)}" title="Aprovar" aria-label="Aprovar usuário"><svg><use href="#i-check"/></svg></button>` : ''}
              ${user.email !== S.user?.email ? `<button type="button" class="danger" data-action="user-delete" data-email="${esc(user.email)}" title="Excluir" aria-label="Excluir usuário"><svg><use href="#i-trash"/></svg></button>` : ''}
            </div></td>
          </tr>`;
        })
        .join('')
    : emptyRow(6, query ? 'Nenhum usuário corresponde ao filtro.' : 'Nenhum usuário.');
}
function renderAudit(events) {
  setText('#auditCount', `${events.length} evento(s)`);
  const body = $('#auditBody');
  if (!body) return;
  body.innerHTML = events.length
    ? events
        .map((event) => {
          let detail = '';
          if (event.detalhe) {
            try {
              detail = JSON.stringify(JSON.parse(event.detalhe));
            } catch {
              detail = String(event.detalhe);
            }
          }
          return `<tr>
            <td>${esc(fmtDateTime(event.criado_em))}</td>
            <td>${esc(event.usuario || '—')}</td>
            <td><span class="pill pill-blue">${esc(event.acao || '—')}</span></td>
            <td>${esc(event.entidade || '—')}${event.entidade_id ? `<div class="hint">${esc(event.entidade_id)}</div>` : ''}</td>
            <td><span class="audit-detail mono" title="${esc(detail || '—')}">${esc(detail || '—')}</span></td>
          </tr>`;
        })
        .join('')
    : emptyRow(5, 'Nenhum evento de auditoria.');
}
function renderChangePasswordGate() {
  const form = $('#changePasswordForm');
  if (form) {
    form.querySelectorAll('input,button').forEach((el) => {
      el.disabled = false;
    });
  }
}
function renderHealth() {
  const health = S.health;
  const grid = $('#healthGrid');
  const capsEl = $('#healthCaps');
  if (!health) {
    if (grid) grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
    return;
  }
  const caps = health.capabilities || {};
  const ai = caps.aiProvedor || {};
  const aiAtivo = ai.ativo || '';
  const aiLabel = aiAtivo === 'grok' ? 'Grok' : aiAtivo === 'workers-ai' ? 'Llama' : caps.ai ? 'IA' : 'Regras';
  const aiModel = aiAtivo === 'grok' ? ai.grok?.modelo : aiAtivo === 'workers-ai' ? ai.llama?.modelo : '';
  const aiDetail = aiModel
    ? `${aiAtivo === 'grok' ? 'xAI' : 'Workers AI'} · ${aiModel}`
    : caps.ai
      ? 'Provedor configurado no Worker'
      : 'Fallback determinístico';
  const cards = [
    { label: 'Worker', value: health.worker || 'waitron-server', detail: `v${health.version || '2.2.0'} · ${health.env || 'production'}`, on: true },
    { label: 'D1 Database', value: caps.d1 ? 'Conectado' : 'Offline', detail: caps.d1 ? 'Persistência operacional' : 'Binding DB ausente', on: Boolean(caps.d1) },
    { label: 'IA · Grok / Llama', value: aiLabel, detail: aiDetail, on: Boolean(caps.ai) },
    { label: 'Zernio / WhatsApp', value: caps.zernio ? 'Conectado' : 'Pendente', detail: caps.webhookAssinado ? 'Webhook assinado' : 'Webhook sem secret', on: Boolean(caps.zernio) },
  ];
  if (grid) {
    grid.innerHTML = cards
      .map(
        (card) => `<article class="health-card">
          <div class="health-card-head"><strong>${esc(card.label)}</strong><span class="pill ${card.on ? 'pill-mint' : 'pill-amber'}">${card.on ? 'ON' : 'OFF'}</span></div>
          <div style="font-size:17px;font-weight:800;color:#0f1b30">${esc(card.value)}</div>
          <p>${esc(card.detail)}</p>
        </article>`
      )
      .join('');
  }
  if (capsEl) {
    const entries = [
      ['D1', caps.d1], ['Assets', caps.assets], ['Llama', ai.llama?.configurado ?? caps.ai], ['Grok', ai.grok?.configurado], ['Zernio', caps.zernio],
      ['Webhook HMAC', caps.webhookAssinado], ['Asaas', caps.asaas], ['Inter', caps.inter],
      ['Inter mTLS', caps.interMtls], ['UPI / GPay', caps.upi], ['Apple Pay', caps.applePay], ['PIX', caps.pix],
    ];
    capsEl.innerHTML = entries
      .map(
        ([label, on]) => `<div class="cap-item ${on ? 'on' : ''}"><svg><use href="#${on ? 'i-check' : 'i-close'}"/></svg><span>${esc(label)}</span><strong>${on ? 'on' : 'off'}</strong></div>`
      )
      .join('');
    const onCount = entries.filter(([, on]) => on).length;
    setText('#healthSummary', `${onCount}/${entries.length} ativos`);
  }
  setText('#sysVersion', health.version || '—');
  setText('#sysEnv', health.env || '—');
  const sidebarMeta = $('#sidebarConnMeta');
  if (sidebarMeta) sidebarMeta.textContent = `D1 ${caps.d1 ? 'on' : 'off'} · IA ${aiLabel} · Zernio ${caps.zernio ? 'on' : 'off'}`;
}

function setConnection(online) {
  const pill = $('#connPill');
  if (pill) {
    pill.classList.toggle('offline', !online);
    pill.innerHTML = `<span class="pulse-dot"></span><span>${online ? 'Online' : 'Offline'}</span>`;
  }
  const sidebar = $('#sidebarConnText');
  if (sidebar) sidebar.textContent = online ? 'Conectado' : 'Modo offline';
  const mode = $('#sidebarConnMode');
  if (mode) mode.textContent = online ? 'edge' : 'cache';
}

/* ── modals ─────────────────────────────────────────────── */
function openModal({ title, subtitle = '', body, footer = '', wide = false, onMount, onClose }) {
  const root = $('#modalRoot');
  if (!root) return null;
  stopScanner();
  root.innerHTML = `
    <div class="modal-backdrop" data-close-modal></div>
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div><h3>${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button type="button" class="modal-close" data-close-modal aria-label="Fechar"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  `;
  root.classList.add('open');
  document.body.style.overflow = 'hidden';
  root.dataset.onClose = '';
  root._onClose = onClose || null;
  if (onMount) onMount(root);
  const firstInput = root.querySelector('input:not([type="hidden"]),textarea,select');
  if (firstInput) setTimeout(() => firstInput.focus(), 80);
  return root.querySelector('.modal');
}
function closeModal() {
  const root = $('#modalRoot');
  if (!root || !root.classList.contains('open')) return;
  stopScanner();
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.style.overflow = '';
  const callback = root._onClose;
  root._onClose = null;
  if (typeof callback === 'function') callback();
}
function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title,
      body: `<p class="confirm-box">${message}</p>`,
      footer: `<button type="button" class="btn btn-ghost" data-confirm-cancel>Cancelar</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${esc(confirmLabel)}</button>`,
      onMount(root) {
        root.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => finish(false));
        root.querySelector('[data-confirm-ok]')?.addEventListener('click', () => finish(true));
        root.querySelector('.modal-backdrop')?.addEventListener('click', () => finish(false));
        root.querySelector('.modal-close')?.addEventListener('click', () => finish(false));
      },
      onClose() {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}

function openProductModal(product = null) {
  const editing = Boolean(product);
  const value = (key, fallback = '') => esc(product?.[key] ?? fallback);
  openModal({
    title: editing ? 'Editar produto' : 'Novo produto',
    subtitle: 'Código de barras, preço e tributação.',
    body: `<form id="productForm">
      <div class="scan-box">
        <div class="scan-box-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="modalScanBtn"><svg><use href="#i-scan"/></svg> Ler código</button>
          <button type="button" class="btn btn-ghost btn-sm" id="modalScanStop"><svg><use href="#i-close"/></svg> Parar</button>
          <span class="hint">Câmera traseira · BarcodeDetector nativo</span>
        </div>
        <video id="modalScanVideo" playsinline muted hidden style="width:100%;max-height:150px;border-radius:8px;background:#000"></video>
      </div>
      <label class="field"><span>Nome *</span><input type="text" id="mNome" value="${value('nome')}" required/></label>
      <div class="field-row">
        <label class="field"><span>SKU</span><input type="text" id="mSku" value="${value('sku')}" ${editing ? 'readonly' : ''} placeholder="Automático se vazio"/></label>
        <label class="field"><span>Código de barras / EAN</span><input type="text" id="mBarras" value="${value('barras')}"/></label>
      </div>
      <div class="field-row">
        <label class="field"><span>NCM *</span><input type="text" id="mNcm" value="${value('ncm')}" maxlength="8" placeholder="22021000"/></label>
        <label class="field"><span>CNP</span><input type="text" id="mCnp" value="${value('cnp')}" placeholder="Opcional"/></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Preço (R$)</span><input type="number" step="0.01" min="0" id="mPreco" value="${value('preco', '0')}"/></label>
        <label class="field"><span>Estoque</span><input type="number" min="0" id="mEstoque" value="${value('estoque', '0')}"/></label>
      </div>
      <div class="field-row">
        <label class="field"><span>ICMS %</span><input type="number" step="0.01" min="0" max="100" id="mIcms" value="${value('icms', '18')}"/></label>
        <label class="field"><span>CFOP</span><select id="mCfop">
          ${['5102', '5405', '5933'].map((cfop) => `<option value="${cfop}" ${String(product?.cfop || '5102') === cfop ? 'selected' : ''}>${cfop}</option>`).join('')}
        </select></label>
      </div>
      <p class="hint">Preço e impostos são recalculados pelo servidor no momento da venda. O estoque é baixado automaticamente.</p>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="productForm" class="btn btn-primary" id="productSaveBtn">Salvar produto</button>`,
    wide: true,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#modalScanBtn')?.addEventListener('click', async () => {
        const video = root.querySelector('#modalScanVideo');
        video.hidden = false;
        const started = await startScanner(video, (code) => {
          const input = root.querySelector('#mBarras');
          if (input) input.value = code;
          video.hidden = true;
          toast(`Código lido: ${code}`, 'ok');
        });
        if (!started) video.hidden = true;
      });
      root.querySelector('#modalScanStop')?.addEventListener('click', () => {
        stopScanner();
        const video = root.querySelector('#modalScanVideo');
        if (video) video.hidden = true;
      });
      root.querySelector('#productForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#productSaveBtn');
        const nome = root.querySelector('#mNome').value.trim();
        if (!nome) return toast('Informe o nome do produto.', 'err');
        const payload = {
          sku: root.querySelector('#mSku').value.trim() || undefined,
          nome,
          barras: root.querySelector('#mBarras').value.trim(),
          ncm: root.querySelector('#mNcm').value.trim(),
          cnp: root.querySelector('#mCnp').value.trim(),
          preco: numberValue(root.querySelector('#mPreco').value),
          estoque: Number(root.querySelector('#mEstoque').value) || 0,
          icms: numberValue(root.querySelector('#mIcms').value),
          cfop: root.querySelector('#mCfop').value,
        };
        busy(button, true, 'Salvando…');
        try {
          await api('/api/produtos', { method: 'POST', body: payload });
          closeModal();
          toast(editing ? 'Produto atualizado.' : 'Produto cadastrado.', 'ok');
          await loadSync();
          await loadDashboardPage();
          renderPdvProducts();
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function openPersonModal(person = null) {
  const editing = Boolean(person);
  openModal({
    title: editing ? 'Editar pessoa' : 'Nova pessoa',
    subtitle: 'Documento, contato e tipo de cadastro.',
    body: `<form id="personForm">
      <label class="field"><span>CPF / CNPJ</span><input type="text" id="mDoc" value="${esc(person?.doc || '')}" placeholder="Digite para consultar CNPJ na BrasilAPI"/></label>
      <p class="wa-new-hint" id="docLookupHint">CNPJ com 14 dígitos consulta a Receita via BrasilAPI (cache no Worker).</p>
      <label class="field"><span>Nome / Razão social *</span><input type="text" id="mPersonNome" value="${esc(person?.nome || '')}" required/></label>
      <div class="field-row">
        <label class="field"><span>WhatsApp</span><input type="tel" id="mPersonTel" value="${esc(person?.tel || '')}" placeholder="11999999999"/></label>
        <label class="field"><span>Tipo</span><select id="mTipo"><option value="PF" ${person?.tipo !== 'PJ' ? 'selected' : ''}>PF</option><option value="PJ" ${person?.tipo === 'PJ' ? 'selected' : ''}>PJ</option></select></label>
      </div>
      <label class="field"><span>E-mail</span><input type="email" id="mPersonEmail" value="${esc(person?.email || '')}"/></label>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="personForm" class="btn btn-primary" id="personSaveBtn">Salvar pessoa</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      const docInput = root.querySelector('#mDoc');
      docInput?.addEventListener('blur', async () => {
        const doc = digits(docInput.value);
        if (doc.length !== 14) return;
        const hint = root.querySelector('#docLookupHint');
        if (hint) hint.textContent = 'Consultando CNPJ…';
        try {
          const data = await api(`/cnpj/${doc}`, { auth: false });
          if (!root.querySelector('#mPersonNome').value) root.querySelector('#mPersonNome').value = data.nome || data.razao_social || '';
          if (!root.querySelector('#mPersonEmail').value) root.querySelector('#mPersonEmail').value = data.email || '';
          if (!root.querySelector('#mPersonTel').value) root.querySelector('#mPersonTel').value = digits(data.telefone || '');
          const tipo = root.querySelector('#mTipo');
          if (tipo) tipo.value = 'PJ';
          if (hint) hint.textContent = `${data.razao_social || data.nome || 'CNPJ encontrado'}${data.situacao ? ` · ${data.situacao}` : ''}`;
        } catch (error) {
          if (hint) hint.textContent = `Consulta CNPJ: ${error.message}`;
        }
      });
      root.querySelector('#personForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#personSaveBtn');
        const nome = root.querySelector('#mPersonNome').value.trim();
        if (!nome) return toast('Informe o nome.', 'err');
        const payload = {
          id: editing ? Number(person.id) : undefined,
          nome,
          doc: digits(root.querySelector('#mDoc').value) || null,
          tipo: root.querySelector('#mTipo').value,
          tel: digits(root.querySelector('#mPersonTel').value),
          email: root.querySelector('#mPersonEmail').value.trim(),
        };
        busy(button, true, 'Salvando…');
        try {
          await api('/api/pessoas', { method: 'POST', body: payload });
          closeModal();
          toast(editing ? 'Pessoa atualizada.' : 'Pessoa cadastrada.', 'ok');
          await loadSync();
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function openLeadModal() {
  openModal({
    title: 'Novo lead',
    subtitle: 'Contato para campanhas e atendimento pelo WhatsApp.',
    body: `<form id="leadForm">
      <label class="field"><span>Nome</span><input type="text" id="mLeadNome" placeholder="Cliente"/></label>
      <div class="field-row">
        <label class="field"><span>WhatsApp *</span><input type="tel" id="mLeadTel" required placeholder="11999999999"/></label>
        <label class="field"><span>CPF / CNPJ</span><input type="text" id="mLeadDoc"/></label>
      </div>
      <label class="field"><span>Valor de referência (R$)</span><input type="number" step="0.01" min="0" id="mLeadValor"/></label>
      <label class="check-line"><input type="checkbox" id="mLeadBuy"/> Registrar uma compra neste cadastro</label>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="leadForm" class="btn btn-primary" id="leadSaveBtn">Salvar lead</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#leadForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#leadSaveBtn');
        const tel = digits(root.querySelector('#mLeadTel').value);
        if (tel.length < 10) return toast('Telefone inválido.', 'err');
        busy(button, true, 'Salvando…');
        try {
          await api('/api/leads', {
            method: 'POST',
            body: {
              nome: root.querySelector('#mLeadNome').value.trim() || 'Cliente',
              tel,
              doc: digits(root.querySelector('#mLeadDoc').value) || null,
              valor: numberValue(root.querySelector('#mLeadValor').value),
              registrarCompra: root.querySelector('#mLeadBuy').checked,
            },
          });
          closeModal();
          toast('Lead salvo.', 'ok');
          await loadSync();
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function openWhatsAppModal({ tel = '', nome = '', message = '' } = {}) {
  openModal({
    title: 'Enviar WhatsApp',
    subtitle: nome ? `Contato: ${nome}` : 'Nova conversa pelo Zernio.',
    body: `<form id="waNewForm">
      <label class="field"><span>WhatsApp *</span><input type="tel" id="waNewTel" value="${esc(tel)}" required placeholder="5511999999999"/></label>
      <label class="field"><span>Mensagem *</span><textarea id="waNewText" rows="4" required>${esc(message || 'Olá! Tudo bem? Estamos por aqui para ajudar com o seu pedido.')}</textarea></label>
      <p class="wa-new-hint">Se o Zernio não estiver configurado, o NoxMob oferece o link wa.me como alternativa segura.</p>
      <div id="waNewResult"></div>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="waNewForm" class="btn btn-primary" id="waNewSend">Enviar mensagem</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#waNewForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#waNewSend');
        const phone = digits(root.querySelector('#waNewTel').value);
        const text = root.querySelector('#waNewText').value.trim();
        if (phone.length < 10 || !text) return toast('Informe telefone e mensagem.', 'err');
        busy(button, true, 'Enviando…');
        try {
          const data = await api('/api/wa/send', { method: 'POST', body: { phone, text } });
          const result = root.querySelector('#waNewResult');
          if (data?.ok) {
            toast('Mensagem enviada pelo WhatsApp.', 'ok');
            closeModal();
            await loadWa();
          } else {
            toast(data?.erro || 'Zernio indisponível. Use o link wa.me.', 'err', 6000);
            if (result) {
              result.innerHTML = `<div class="result-box"><strong>Alternativa segura</strong><p>Abra a conversa no WhatsApp para enviar manualmente.</p><div class="result-actions"><a class="btn btn-ghost btn-sm" href="${esc(data?.waMe || '')}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a></div></div>`;
            }
          }
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function openReplenishModal(sku = '') {
  if (!S.frigo.length) return toast('Cadastre itens no frigobar primeiro.', 'err');
  openModal({
    title: 'Reposição de frigobar',
    subtitle: 'Entrada de estoque registrada na auditoria.',
    body: `<form id="replenishForm">
      <label class="field"><span>Item *</span><select id="mRepSku">${S.frigo.map((item) => `<option value="${esc(item.sku)}" ${item.sku === sku ? 'selected' : ''}>${esc(item.nome)} (${Number(item.estoque) || 0} un.)</option>`).join('')}</select></label>
      <label class="field"><span>Quantidade *</span><input type="number" id="mRepQtd" min="1" max="9999" value="10" required/></label>
      <p class="hint">Requer papel admin ou gerente.</p>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="replenishForm" class="btn btn-primary" id="replenishSave">Confirmar reposição</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#replenishForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#replenishSave');
        busy(button, true, 'Repondo…');
        try {
          await api('/api/frigobar/reposicao', {
            method: 'POST',
            body: { sku: root.querySelector('#mRepSku').value, quantidade: Number(root.querySelector('#mRepQtd').value) || 1 },
          });
          closeModal();
          toast('Estoque reposto.', 'ok');
          await loadHotel();
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function openFrigoModal(item = null) {
  const editing = Boolean(item);
  openModal({
    title: editing ? 'Editar item do frigobar' : 'Novo item do frigobar',
    subtitle: 'Disponível no consumo por palma.',
    body: `<form id="frigoForm">
      <label class="field"><span>SKU *</span><input type="text" id="mFrigoSku" value="${esc(item?.sku || '')}" ${editing ? 'readonly' : ''} required/></label>
      <label class="field"><span>Nome *</span><input type="text" id="mFrigoNome" value="${esc(item?.nome || '')}" required/></label>
      <div class="field-row">
        <label class="field"><span>Preço (R$)</span><input type="number" step="0.01" min="0" id="mFrigoPreco" value="${esc(item?.preco ?? '0')}"/></label>
        <label class="field"><span>Estoque</span><input type="number" min="0" id="mFrigoEstoque" value="${esc(item?.estoque ?? '0')}"/></label>
      </div>
      <label class="field"><span>Estoque mínimo</span><input type="number" min="0" id="mFrigoMin" value="${esc(item?.estoque_minimo ?? '3')}"/></label>
      <p class="hint">Requer papel admin ou gerente.</p>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="frigoForm" class="btn btn-primary" id="frigoSave">Salvar item</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#frigoForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = root.querySelector('#frigoSave');
        busy(button, true, 'Salvando…');
        try {
          await api('/api/frigobar/itens', {
            method: 'POST',
            body: {
              sku: root.querySelector('#mFrigoSku').value.trim(),
              nome: root.querySelector('#mFrigoNome').value.trim(),
              preco: numberValue(root.querySelector('#mFrigoPreco').value),
              estoque: Number(root.querySelector('#mFrigoEstoque').value) || 0,
              estoque_minimo: Number(root.querySelector('#mFrigoMin').value) || 0,
            },
          });
          closeModal();
          toast('Item do frigobar salvo.', 'ok');
          await loadHotel();
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          busy(button, false);
        }
      });
    },
  });
}

function paymentResultHtml(result) {
  const qrImage = result?.qr?.encodedImage || result?.qrImage;
  const payload = result?.qr?.payload || result?.qrPayload || result?.pixCopiaECola || '';
  const link = result?.invoiceUrl || result?.checkoutUrl || '';
  const upi = result?.uri || result?.gpayIntent || '';
  const status = result?.status || 'pendente';
  const valor = result?.valor;
  return `<div class="result-box">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong>Cobrança criada</strong>${statusPill(status)}${valor ? `<span class="chip">${money(valor)}</span>` : ''}</div>
    ${qrImage ? `<img class="result-qr" alt="QR Code PIX" src="${esc(qrImage.startsWith('data:') ? qrImage : `data:image/png;base64,${qrImage}`)}"/>` : ''}
    ${payload ? `<p class="hint" style="margin-top:8px">PIX copia-e-cola:</p><div class="pix-code">${esc(payload)}</div>` : ''}
    ${result?.txid ? `<p class="hint" style="margin-top:7px">TXID: <code>${esc(result.txid)}</code></p>` : ''}
    ${link ? `<div class="result-actions"><a class="btn btn-primary btn-sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Abrir checkout seguro</a></div>` : ''}
    ${upi ? `<p class="hint" style="margin-top:8px">Deep link UPI:</p><div class="pix-code">${esc(upi)}</div><div class="result-actions"><a class="btn btn-ghost btn-sm" href="${esc(result.uri || upi)}" target="_blank" rel="noopener noreferrer">Abrir app de pagamento</a></div>` : ''}
    ${result?.aviso ? `<p class="hint" style="margin-top:8px">${esc(result.aviso)}</p>` : ''}
    <p class="hint" style="margin-top:8px">Nenhum dado de cartão é armazenado pelo NoxMob. O checkout acontece no ambiente do provedor.</p>
  </div>`;
}
function showPaymentResult(result, title = 'Resultado da cobrança') {
  openModal({
    title,
    subtitle: 'Cobrança registrada no D1 e pronta para o cliente.',
    body: `<div id="payResultMount">${paymentResultHtml(result)}</div>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Fechar</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      const payload = result?.qr?.payload || result?.qrPayload || result?.pixCopiaECola || '';
      if (payload) {
        const actions = root.querySelector('.result-actions');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-sm';
        button.textContent = 'Copiar PIX';
        button.addEventListener('click', () => copyText(payload));
        if (actions) actions.prepend(button);
        else {
          const host = root.querySelector('.result-box');
          const wrap = document.createElement('div');
          wrap.className = 'result-actions';
          wrap.appendChild(button);
          host?.appendChild(wrap);
        }
      }
    },
  });
}
function showReceiptPrompt(sale) {
  openModal({
    title: 'Venda concluída',
    subtitle: 'Pagamento em dinheiro / já recebido.',
    body: `<div class="result-box"><strong>${money(sale.total)}</strong><p>Venda ${esc(sale.numero || sale.id)} registrada. Estoque atualizado no D1.</p></div>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Fechar</button><button type="button" class="btn btn-primary" id="printReceiptBtn"><svg><use href="#i-receipt"/></svg> Imprimir comprovante</button>`,
    onMount(root) {
      root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
      root.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', closeModal));
      root.querySelector('#printReceiptBtn')?.addEventListener('click', () => printSale(sale));
    },
  });
}
function printSale(sale) {
  const items = (sale.itens || [])
    .map(
      (item) => `<tr><td>${esc(item.nome || item.sku)}</td><td>${Number(item.qtd) || 1}</td><td>${money(item.preco)}</td><td>${money((Number(item.preco) || 0) * (Number(item.qtd) || 1))}</td></tr>`
    )
    .join('');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante NoxMob</title>
    <style>body{font-family:Arial,sans-serif;max-width:320px;margin:0 auto;padding:16px;color:#111;font-size:12px}h1{font-size:18px;margin:0 0 2px}.muted{color:#555}.line{border-top:1px dashed #999;margin:12px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:4px 0;font-size:11px}td:last-child,th:last-child{text-align:right}.total{font-size:16px;font-weight:bold;display:flex;justify-content:space-between;margin-top:10px}footer{text-align:center;color:#666;font-size:10px;margin-top:16px}</style>
    </head><body>
    <h1>NoxMob</h1><div class="muted">Comprovante de venda</div>
    <div class="line"></div>
    <div>Venda: <strong>${esc(sale.numero || sale.id || '—')}</strong></div>
    <div>Data: ${esc(fmtDateTime(sale.data || new Date().toISOString()))}</div>
    ${sale.cliente ? `<div>Cliente: ${esc(sale.cliente)}</div>` : ''}
    <div class="line"></div>
    <table><thead><tr><th>Item</th><th>Qtd</th><th>Preço</th><th>Total</th></tr></thead><tbody>${items}</tbody></table>
    <div class="total"><span>Total</span><span>${money(sale.total)}</span></div>
    <div class="line"></div>
    <footer>Obrigado pela preferência.<br/>NoxMob SmartPOS · documento não fiscal</footer>
    </body></html>`;
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 1500);
    }
  }, 250);
}

/* ── payment operations ────────────────────────────────── */
async function createPaymentForSale(method, payload) {
  if (method === 'pix_auto') {
    try {
      return await api('/api/pay/asaas/pix', { method: 'POST', body: payload });
    } catch (firstError) {
      if (firstError.status === 401) throw firstError;
      try {
        return await api('/api/pay/inter/pix', { method: 'POST', body: payload });
      } catch (secondError) {
        throw new Error(`${firstError.message} · ${secondError.message}`);
      }
    }
  }
  const endpoints = {
    asaas_pix: '/api/pay/asaas/pix',
    asaas_checkout: '/api/pay/asaas/checkout',
    inter_pix: '/api/pay/inter/pix',
    upi: '/api/pay/upi',
  };
  const endpoint = endpoints[method];
  if (!endpoint) throw new Error('Método de pagamento inválido.');
  return api(endpoint, { method: 'POST', body: payload });
}
async function submitPaymentForm(event) {
  event.preventDefault();
  const button = $('#paySubmit');
  const method = $('#payMetodo').value;
  const valor = numberValue($('#payValor').value);
  if (valor <= 0) return toast('Informe um valor maior que zero.', 'err');
  busy(button, true, 'Gerando…');
  try {
    const result = await createPaymentForSale(method, {
      valor,
      descricao: $('#payDescricao').value.trim() || 'Cobrança NoxMob',
      clienteNome: $('#payCliente').value.trim(),
      vendaId: Number($('#payVenda').value) || undefined,
    });
    const mount = $('#paymentResult');
    if (mount) {
      mount.hidden = false;
      mount.innerHTML = paymentResultHtml(result);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-ghost btn-sm';
      copyBtn.textContent = 'Copiar PIX';
      const pix = result?.qr?.payload || result?.qrPayload || result?.pixCopiaECola;
      if (pix) {
        copyBtn.addEventListener('click', () => copyText(pix));
        mount.querySelector('.result-box')?.appendChild(copyBtn);
      }
    }
    toast('Cobrança gerada.', 'ok');
    await loadPayments();
    await loadDashboardPage();
  } catch (error) {
    toast(error.message, 'err', 6000);
  } finally {
    busy(button, false);
  }
}
async function checkPaymentStatus(provider, external) {
  try {
    const endpoint = provider === 'asaas'
      ? `/api/pay/asaas/status/${encodeURIComponent(external)}`
      : `/api/pay/inter/status/${encodeURIComponent(external)}`;
    const data = await api(endpoint);
    toast(`Status atualizado: ${data.status || '—'}`, data.status === 'pago' ? 'ok' : 'info');
    await loadPayments();
    await loadDashboardPage();
  } catch (error) {
    toast(error.message, 'err');
  }
}
async function confirmUpi(txid) {
  const confirmed = await confirmDialog({
    title: 'Confirmar pagamento UPI?',
    message: `Confirme apenas após verificar o recebimento no PSP. TXID: <strong>${esc(txid)}</strong>`,
    confirmLabel: 'Confirmar recebimento',
  });
  if (!confirmed) return;
  try {
    await api('/api/pay/upi/confirm', { method: 'POST', body: { txid, status: 'pago' } });
    toast('Pagamento UPI confirmado.', 'ok');
    await loadPayments();
    await loadDashboardPage();
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ── hotel / palm operations ───────────────────────────── */
async function submitGuest(event) {
  event.preventDefault();
  const button = $('#guestSubmit');
  const payload = {
    nome: $('#guestName').value.trim(),
    cpf: digits($('#guestCpf').value),
    tel: digits($('#guestPhone').value),
    quarto: $('#guestRoom').value.trim(),
    vein_template_b64: $('#guestTemplate').value.trim(),
  };
  if (!payload.nome || !payload.quarto) return toast('Informe nome e quarto.', 'err');
  if (payload.vein_template_b64.length < 16) return toast('Template biométrico inválido. Use o leitor palm-vein ou gere um template de teste.', 'err');
  busy(button, true, 'Cadastrando…');
  try {
    const data = await api('/api/palm/register', { method: 'POST', body: payload });
    toast(data.msg || 'Hóspede cadastrado.', 'ok');
    $('#guestForm').reset();
    await loadHotel();
    await loadSync();
  } catch (error) {
    toast(error.message, 'err', 6000);
  } finally {
    busy(button, false);
  }
}
async function submitCharge(event) {
  event.preventDefault();
  const button = $('#chargeSubmit');
  const template = $('#chargeTemplate').value.trim();
  const quarto = $('#chargeRoom').value.trim();
  const itens = chargeSelections();
  if (template.length < 16) return toast('Leia o template biométrico antes de cobrar.', 'err');
  if (!itens.length) return toast('Selecione pelo menos um item.', 'err');
  busy(button, true, 'Identificando…');
  const resultBox = $('#chargeResult');
  try {
    const data = await api('/api/palm/identify-and-charge', {
      method: 'POST',
      body: { vein_template_b64: template, quarto: quarto || undefined, itens },
    });
    if (resultBox) {
      resultBox.hidden = false;
      resultBox.className = 'result-box';
      const pix = data.pixCopiaECola || '';
      resultBox.innerHTML = `<strong>${esc(data.msg || 'Consumo registrado')}</strong>
        <p>Hóspede: ${esc(data.hospede?.nome || '—')} · Quarto ${esc(data.quarto || quarto || '—')}</p>
        <p>Valor: <strong>${money(data.valor)}</strong> · Status: ${statusPill(data.status === 'pago' ? 'pago' : data.status || 'pendente')}</p>
        ${data.txid ? `<p class="hint">TXID: <code>${esc(data.txid)}</code></p>` : ''}
        ${pix ? `<p class="hint">PIX copia-e-cola:</p><div class="pix-code">${esc(pix)}</div>` : ''}`;
    }
    toast('Consumo cobrado com sucesso.', 'ok');
    await loadHotel();
    await loadDashboardPage();
  } catch (error) {
    if (resultBox) {
      resultBox.hidden = false;
      resultBox.className = 'result-box err';
      resultBox.innerHTML = `<strong>Não foi possível cobrar.</strong><p>${esc(error.message)}</p>`;
    }
    toast(error.message, 'err', 6000);
  } finally {
    busy(button, false);
  }
}

/* ── WhatsApp config ──────────────────────────────────── */
async function saveWaConfig(event) {
  event.preventDefault();
  const button = $('#waConfigSubmit');
  busy(button, true, 'Salvando…');
  try {
    const data = await api('/api/wa/config', {
      method: 'PUT',
      body: {
        ia_ativa: $('#waIaAtiva').checked,
        nome_empresa: $('#waNomeEmpresa').value.trim(),
        horario: $('#waHorario').value.trim(),
        account_id: $('#waAccountId').value.trim(),
        profile_id: $('#waProfileId').value.trim(),
        prompt_sistema: $('#waPrompt').value.trim(),
        mensagem_boas_vindas: $('#waWelcome').value.trim(),
        mensagem_fora_horario: $('#waOffHours').value.trim(),
      },
    });
    S.wa.config = data.config;
    renderWaConfig();
    renderWaStatus();
    toast('Configuração do WhatsApp salva.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

/* ── users ────────────────────────────────────────────── */
async function changeUserRole(select) {
  const email = select.dataset.email;
  const papel = select.value;
  try {
    await api('/auth/role', { method: 'POST', body: { email, papel } });
    toast(`Papel de ${email} alterado para ${papel}.`, 'ok');
    await loadUsers();
  } catch (error) {
    toast(error.message, 'err');
    await loadUsers();
  }
}
async function approveUser(email) {
  try {
    await api('/auth/approve', { method: 'POST', body: { email } });
    toast('Usuário aprovado.', 'ok');
    await loadUsers();
  } catch (error) {
    toast(error.message, 'err');
  }
}
async function deleteUser(email) {
  const confirmed = await confirmDialog({
    title: 'Excluir usuário?',
    message: `A conta <strong>${esc(email)}</strong> e suas sessões serão removidas. Esta ação é permanente.`,
    confirmLabel: 'Excluir usuário',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api('/auth/delete', { method: 'POST', body: { email } });
    toast('Usuário excluído.', 'ok');
    await loadUsers();
  } catch (error) {
    toast(error.message, 'err');
  }
}
async function changePassword(event) {
  event.preventDefault();
  const atual = $('#currentPassword').value;
  const nova = $('#newPassword').value;
  const confirm = $('#confirmPassword').value;
  if (nova.length < 8) return toast('A nova senha precisa ter pelo menos 8 caracteres.', 'err');
  if (nova !== confirm) return toast('As senhas não conferem.', 'err');
  try {
    const data = await api('/auth/change-password', { method: 'POST', body: { atual, nova } });
    toast(data.msg || 'Senha alterada.', 'ok');
    $('#changePasswordForm').reset();
    setTimeout(() => handleLogout(true), 1400);
  } catch (error) {
    toast(error.message, 'err');
  }
}

function openUserDocModal(email, currentDoc = '') {
  openModal({
    title: currentDoc ? 'Alterar CPF/CNPJ' : 'Vincular CPF/CNPJ',
    subtitle: `Documento do acesso ${email}`,
    body: `<form id="userDocForm">
      <label class="field"><span>CPF ou CNPJ</span><input type="text" id="userDocInput" inputmode="numeric" autocomplete="off" maxlength="18" placeholder="000.000.000-00" value="${esc(currentDoc ? fmtDoc(currentDoc) : '')}" required/></label>
      <p class="hint">O documento é validado pelos dígitos verificadores e armazenado apenas com números. Ele permite login por CPF/CNPJ e aparece no histórico de acessos.</p>
      <p class="hint">Senhas, hashes e dados de cartão nunca são exibidos nesta consulta.</p>
    </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close-modal>Cancelar</button><button type="submit" form="userDocForm" class="btn btn-primary" id="userDocSubmit"><svg><use href="#i-check"/></svg> Salvar documento</button>`,
    onMount: (root) => {
      const input = root.querySelector('#userDocInput');
      input?.addEventListener('input', () => {
        input.value = maskDoc(input.value);
      });
      root.querySelector('#userDocForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = input?.value || '';
        if (!docType(value)) return toast('Informe um CPF ou CNPJ válido.', 'err');
        const button = root.querySelector('#userDocSubmit');
        busy(button, true, 'Salvando…');
        try {
          await api('/auth/users/doc', { method: 'POST', body: { email, doc: digits(value) } });
          toast('CPF/CNPJ vinculado ao usuário.', 'ok');
          closeModal();
          await loadUsers();
        } catch (error) {
          toast(error.message, 'err');
          busy(button, false);
        }
      });
    },
  });
}

async function trackUser(event) {
  if (event) event.preventDefault();
  const input = $('#trackInput');
  if (!input) return;
  const term = input.value.trim();
  if (!term) return toast('Informe um CPF/CNPJ, e-mail ou nome para rastrear.', 'err');
  const numeric = /^[\d.\-/\s]+$/.test(term);
  if (numeric && !docType(term)) {
    return toast('Informe um CPF ou CNPJ válido com os dígitos verificadores.', 'err');
  }
  if (!numeric && term.length < 3) {
    return toast('Informe ao menos 3 caracteres para a busca.', 'err');
  }
  const button = $('#trackSubmit');
  busy(button, true, 'Consultando…');
  try {
    const data = await api(`/auth/users/lookup?q=${encodeURIComponent(term)}`);
    renderTracker(data, numeric ? fmtDoc(term) : term);
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    busy(button, false);
  }
}

function renderTracker(data, term) {
  const box = $('#trackResults');
  if (!box) return;
  const usuarios = Array.isArray(data?.usuarios) ? data.usuarios : [];
  const sessoes = Array.isArray(data?.sessoes) ? data.sessoes : [];
  const acessos = Array.isArray(data?.acessos) ? data.acessos : [];
  const pessoas = Array.isArray(data?.pessoas) ? data.pessoas : [];
  const leads = Array.isArray(data?.leads) ? data.leads : [];
  const pagamentos = Array.isArray(data?.pagamentos) ? data.pagamentos : [];
  const auditoria = Array.isArray(data?.auditoria) ? data.auditoria : [];
  const ativas = sessoes.filter((item) => Number(item.ativa) === 1).length;
  const hasAny = usuarios.length + sessoes.length + acessos.length + pessoas.length + leads.length + pagamentos.length + auditoria.length > 0;
  const item = (title, subtitle, meta) => `<div class="tracker-item">
    <div class="tracker-item-main"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div>
    <span class="tracker-item-meta">${esc(meta)}</span>
  </div>`;
  const card = (title, icon, rows) => `<section class="tracker-card">
    <h4><svg><use href="#${icon}"/></svg>${esc(title)}</h4>
    <div class="tracker-list">${rows.length ? rows.join('') : '<p class="tracker-empty">Nenhum registro.</p>'}</div>
  </section>`;
  const userRows = usuarios.slice(0, 10).map((user) =>
    item(user.nome || user.email, `${user.email} · ${user.papel || 'operador'}`, `${user.status || '—'} · ${Number(user.sessoes_ativas) || 0} sessão(ões)`)
  );
  const sessionRows = sessoes.slice(0, 12).map((session) =>
    item(session.usuario_email, `${session.ip || 'IP não registrado'} · ${Number(session.ativa) === 1 ? 'ativa' : 'encerrada'}`, fmtDateTime(session.criado_em))
  );
  const accessRows = acessos.slice(0, 15).map((access) =>
    item(access.evento || 'acesso', `${access.usuario_email || '—'} · ${access.ip || 'IP não registrado'}`, fmtDateTime(access.criado_em))
  );
  const peopleRows = pessoas.slice(0, 8).map((person) =>
    item(person.nome || 'Pessoa', `${person.tel || person.email || 'sem contato'} · ${person.tipo || 'pessoa'}`, fmtDate(person.criado_em))
  );
  const leadRows = leads.slice(0, 8).map((lead) =>
    item(`${lead.nome || 'Lead'} · lead`, `${Number(lead.compras) || 0} compra(s) · ${money(lead.valor)}`, lead.ultima_compra ? fmtDate(lead.ultima_compra) : fmtDate(lead.criado_em))
  );
  const paymentRows = pagamentos.slice(0, 10).map((payment) =>
    item(`#${payment.id} · ${payment.cliente_nome || 'Cliente'}`, `${payment.metodo || payment.provider || '—'} · ${payment.status || '—'}`, money(payment.valor))
  );
  const auditRows = auditoria.slice(0, 12).map((event) =>
    item(event.acao || 'evento', `${event.usuario || '—'} · ${event.ip || 'sem IP'}`, fmtDateTime(event.criado_em))
  );

  box.hidden = false;
  box.innerHTML = `
    <div class="tracker-summary">
      <div class="tracker-stat"><span>Cadastros</span><strong>${usuarios.length}</strong></div>
      <div class="tracker-stat"><span>Sessões ativas</span><strong>${ativas}</strong></div>
      <div class="tracker-stat"><span>Acessos</span><strong>${acessos.length}</strong></div>
      <div class="tracker-stat"><span>Pagamentos</span><strong>${pagamentos.length}</strong></div>
    </div>
    <p class="hint" style="margin:0 0 11px">Consulta <span class="doc-chip"><svg><use href="#i-id"/></svg>${esc(term || data?.consulta?.termo || '—')}</span>${data?.consulta?.tipo ? ` · ${esc(data.consulta.tipo)}` : ''}</p>
    ${hasAny ? `<div class="tracker-grid">
      ${card(`Usuários (${usuarios.length})`, 'i-users', userRows)}
      ${card(`Sessões (${sessoes.length})`, 'i-shield', sessionRows)}
      ${card(`Histórico de acessos (${acessos.length})`, 'i-clock', accessRows)}
      ${card(`Pessoas & leads (${pessoas.length + leads.length})`, 'i-id', [...peopleRows, ...leadRows])}
      ${card(`Pagamentos (${pagamentos.length})`, 'i-wallet', paymentRows)}
      ${card(`Auditoria (${auditoria.length})`, 'i-layers', auditRows)}
    </div>` : '<div class="tracker-empty">Nenhum registro encontrado para esta consulta. Verifique os dígitos ou vincule o CPF/CNPJ a um usuário.</div>'}
  `;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── exports ──────────────────────────────────────────── */
function exportProductsCsv() {
  if (!S.products.length) return toast('Nenhum produto para exportar.', 'err');
  const rows = [['SKU', 'Nome', 'Barras', 'NCM', 'CNP', 'Preço', 'Estoque', 'ICMS', 'CFOP']];
  S.products.forEach((product) => {
    rows.push([product.sku, product.nome, product.barras, product.ncm, product.cnp, product.preco, product.estoque, product.icms, product.cfop]);
  });
  downloadFile(`noxmob-produtos-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${toCsv(rows)}`, 'text/csv;charset=utf-8');
  toast('CSV de produtos exportado.', 'ok');
}
function exportReportCsv() {
  const sales = salesForPeriod(S.period);
  if (!sales.length) return toast('Nenhuma venda no período.', 'err');
  const rows = [['Venda', 'Data', 'Cliente', 'Telefone', 'Total', 'Impostos', 'CBS+IBS', 'Itens']];
  sales.forEach((sale) => {
    rows.push([
      sale.numero,
      sale.data || sale.criado_em,
      sale.cliente_nome,
      sale.cliente_tel,
      sale.total,
      sale.impostos,
      sale.cbs_ibs,
      Array.isArray(sale.detalhe) ? sale.detalhe.reduce((sum, item) => sum + (Number(item.qtd) || 0), 0) : 0,
    ]);
  });
  downloadFile(`noxmob-relatorio-${S.period || 'completo'}.csv`, `\ufeff${toCsv(rows)}`, 'text/csv;charset=utf-8');
  toast('Relatório CSV exportado.', 'ok');
}
async function exportAllData() {
  if (!isAdmin()) return toast('Apenas administradores podem exportar o backup completo.', 'err');
  try {
    toast('Preparando backup…', 'info', 1800);
    const data = await api('/api/export');
    downloadFile(`noxmob-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('Backup JSON exportado.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ── AI copilot ───────────────────────────────────────── */
function toggleAi(open) {
  const panel = $('#aiPanel');
  if (!panel) return;
  const next = open === undefined ? !panel.classList.contains('open') : open;
  panel.classList.toggle('open', next);
  if (next) setTimeout(() => $('#aiInput')?.focus(), 120);
}
function closeAi() {
  toggleAi(false);
}
function appendAiMessage(role, text, meta = '') {
  const container = $('#aiMessages');
  if (!container) return;
  const node = document.createElement('div');
  node.className = `ai-msg ${role}`;
  node.innerHTML = `${esc(text)}${meta ? `<span class="ai-meta">${esc(meta)}</span>` : ''}`;
  container.appendChild(node);
  container.scrollTop = container.scrollHeight;
}
function showAiTyping() {
  const container = $('#aiMessages');
  if (!container) return null;
  const node = document.createElement('div');
  node.className = 'ai-typing';
  node.id = 'aiTyping';
  node.innerHTML = '<i></i><i></i><i></i>';
  container.appendChild(node);
  container.scrollTop = container.scrollHeight;
  return node;
}
async function sendAi(question) {
  const text = String(question || '').trim();
  if (!text) return;
  appendAiMessage('user', text);
  S.aiHistory.push({ role: 'user', content: text });
  const typing = showAiTyping();
  const button = $('#aiForm button');
  if (button) button.disabled = true;
  try {
    const history = S.aiHistory.slice(-9);
    const data = await api('/api/ai/chat', {
      method: 'POST',
      body: { pergunta: text, messages: history },
    });
    typing?.remove();
    const providerLabel = data.fonte === 'grok' ? 'Grok' : data.fonte === 'workers-ai' ? 'Llama' : 'Regras locais';
    appendAiMessage('assistant', data.resposta || 'Sem resposta.', `${providerLabel} · ${data.modelo || 'D1'}`);
    S.aiHistory.push({ role: 'assistant', content: data.resposta || '' });
    if (S.aiHistory.length > 16) S.aiHistory = S.aiHistory.slice(-16);
    const source = $('#aiSource');
    if (source) source.textContent = data.fonte === 'grok' ? 'Grok conectado' : data.fonte === 'workers-ai' ? 'Llama conectado' : 'Dados do D1';
  } catch (error) {
    typing?.remove();
    appendAiMessage('assistant', `Não foi possível responder agora: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
    $('#aiInput')?.focus();
  }
}

/* ── barcode scanner ──────────────────────────────────── */
async function startScanner(video, onDetected) {
  stopScanner();
  if (!('BarcodeDetector' in window)) {
    toast('Leitor nativo de código indisponível neste navegador. Digite o código manualmente.', 'info', 6000);
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Câmera não disponível neste dispositivo.', 'err');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    const detector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'],
    });
    let active = true;
    const scan = async () => {
      if (!active) return;
      try {
        const codes = await detector.detect(video);
        if (codes?.length) {
          active = false;
          const code = String(codes[0].rawValue || '').trim();
          stopScanner();
          if (code) onDetected(code);
          return;
        }
      } catch {
        /* frame inválido */
      }
      if (active) S.scanner.raf = requestAnimationFrame(scan);
    };
    S.scanner = {
      stream,
      video,
      raf: requestAnimationFrame(scan),
      stop: () => {
        active = false;
        cancelAnimationFrame(S.scanner?.raf);
        stream.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
        video.hidden = true;
      },
    };
    return true;
  } catch (error) {
    toast(`Câmera: ${error.message || 'permissão negada'}`, 'err');
    return false;
  }
}
function stopScanner() {
  const scanner = S.scanner;
  if (!scanner) return;
  try {
    scanner.stop();
  } catch {
    /* já encerrado */
  }
  S.scanner = null;
  const strip = $('#pdvScanStrip');
  if (strip) strip.hidden = true;
}

/* ── PWA ──────────────────────────────────────────────── */
function setupPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    S.deferredPrompt = event;
    setupPWAInstallVisibility();
  });
  window.addEventListener('appinstalled', () => {
    S.deferredPrompt = null;
    setupPWAInstallVisibility();
    toast('NoxMob instalado neste aparelho.', 'ok');
  });
  window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', setupPWAInstallVisibility);
  setupPWAInstallVisibility();
}
function setupPWAInstallVisibility() {
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone;
  const show = Boolean(S.deferredPrompt) && !standalone;
  ['installBtn', 'installBtnConfig'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  });
  const hint = $('#installHint');
  if (hint) {
    hint.textContent = standalone
      ? 'Aplicativo já instalado neste aparelho.'
      : S.deferredPrompt
        ? 'Prompt de instalação disponível.'
        : 'Use o menu do navegador → Instalar aplicativo (Chrome) ou Compartilhar → Adicionar à Tela de Início (Safari).';
  }
}
async function promptInstall() {
  if (!S.deferredPrompt) {
    toast('Instalação direta indisponível neste navegador. Use o menu → Instalar aplicativo / Adicionar à Tela de Início.', 'info', 7000);
    return;
  }
  S.deferredPrompt.prompt();
  try {
    await S.deferredPrompt.userChoice;
  } catch {
    /* usuário fechou o prompt */
  }
  S.deferredPrompt = null;
  setupPWAInstallVisibility();
}
async function clearAppCache() {
  const confirmed = await confirmDialog({
    title: 'Atualizar cache do aplicativo?',
    message: 'Os arquivos estáticos serão baixados novamente. Vendas na fila offline e a sessão atual são preservadas.',
    confirmLabel: 'Atualizar',
  });
  if (!confirmed) return;
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    toast('Cache atualizado. Recarregando…', 'ok', 1600);
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ── action dispatch ──────────────────────────────────── */
async function handleAction(action, element) {
  try {
    switch (action) {
      case 'toggle-ai':
        toggleAi();
        break;
      case 'close-ai':
        closeAi();
        break;
      case 'logout':
        await handleLogout();
        break;
      case 'install':
        await promptInstall();
        break;
      case 'health':
        await loadHealth();
        toast(S.health?.ok ? 'Conexão com o Worker validada.' : 'Worker indisponível.', S.health?.ok ? 'ok' : 'err');
        break;
      case 'refresh-dashboard':
        await loadDashboardPage();
        break;
      case 'refresh-inventory':
        await loadSync();
        toast('Estoque atualizado.', 'ok');
        break;
      case 'refresh-hotel':
        await loadHotel();
        break;
      case 'refresh-consumos':
        await loadHotel();
        toast('Consumos atualizados.', 'ok');
        break;
      case 'refresh-payments':
        await Promise.all([loadProviders(), loadPayments()]);
        break;
      case 'refresh-users':
        await loadUsers();
        break;
      case 'open-menu':
        openSidebar();
        break;
      case 'close-menu':
        closeSidebar();
        break;
      case 'clear-cart':
        clearCart();
        break;
      case 'cart-inc':
        changeCartQty(element.dataset.sku, 1);
        break;
      case 'cart-dec':
        changeCartQty(element.dataset.sku, -1);
        break;
      case 'cart-remove':
        S.cart = S.cart.filter((line) => line.sku !== element.dataset.sku);
        renderCart();
        break;
      case 'add-to-cart':
        addToCart(element.dataset.sku);
        break;
      case 'new-product':
        openProductModal();
        break;
      case 'edit-product': {
        const product = S.products.find((item) => item.sku === element.dataset.sku);
        if (product) openProductModal(product);
        break;
      }
      case 'delete-product':
        await handleDeleteProduct(element.dataset.sku);
        break;
      case 'export-products':
        exportProductsCsv();
        break;
      case 'new-person':
        openPersonModal();
        break;
      case 'edit-person': {
        const person = S.people.find((item) => String(item.id) === element.dataset.id);
        if (person) openPersonModal(person);
        break;
      }
      case 'delete-person':
        await handleDeletePerson(Number(element.dataset.id));
        break;
      case 'new-lead':
        openLeadModal();
        break;
      case 'wa-person':
        openWhatsAppModal({ tel: element.dataset.tel, nome: element.dataset.nome });
        break;
      case 'new-frigo':
        openFrigoModal();
        break;
      case 'edit-frigo': {
        const item = S.frigo.find((entry) => entry.sku === element.dataset.sku);
        if (item) openFrigoModal(item);
        break;
      }
      case 'replenish-frigo':
        openReplenishModal();
        break;
      case 'replenish-frigo-item':
        openReplenishModal(element.dataset.sku);
        break;
      case 'demo-palm': {
        const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
        const template = `PALM-DEMO-${random}`;
        ['guestTemplate', 'chargeTemplate'].forEach((id) => {
          const input = document.getElementById(id);
          if (input) input.value = template;
        });
        toast('Template de teste gerado nos dois formulários. Use apenas em homologação.', 'info', 6000);
        break;
      }
      case 'pdv-scan': {
        const strip = $('#pdvScanStrip');
        const video = $('#pdvScanVideo');
        if (strip) strip.hidden = false;
        const started = await startScanner(video, (code) => {
          const search = $('#pdvSearch');
          if (search) search.value = code;
          renderPdvProducts();
          const exact = S.products.find((product) => product.barras === code || product.sku === code);
          if (exact) addToCart(exact.sku);
          else toast(`Código ${code} lido. Nenhum produto exato encontrado.`, 'info');
        });
        if (!started && strip) strip.hidden = true;
        break;
      }
      case 'stop-scan':
        stopScanner();
        break;
      case 'export-data':
        await exportAllData();
        break;
      case 'export-report-csv':
        exportReportCsv();
        break;
      case 'clear-cache':
        await clearAppCache();
        break;
      case 'payment-status':
        await checkPaymentStatus(element.dataset.provider, element.dataset.external);
        break;
      case 'payment-confirm-upi':
        await confirmUpi(element.dataset.txid);
        break;
      case 'wa-sync':
        await syncWa();
        break;
      case 'wa-new':
        openWhatsAppModal();
        break;
      case 'wa-open':
        await selectConversation(element.dataset.id);
        break;
      case 'wa-mark-read':
        await markWaRead();
        break;
      case 'wa-ai-toggle':
        await toggleWaAi();
        break;
      case 'wa-ai-reply':
        await waAiReply();
        break;
      case 'user-approve':
        await approveUser(element.dataset.email);
        break;
      case 'user-delete':
        await deleteUser(element.dataset.email);
        break;
      case 'user-track': {
        const panel = $('#trackerPanel');
        const input = $('#trackInput');
        if (input) input.value = fmtDoc(element.dataset.doc || '');
        panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        await trackUser();
        break;
      }
      case 'user-doc':
        openUserDocModal(element.dataset.email, element.dataset.doc || '');
        break;
      default:
        break;
    }
  } catch (error) {
    toast(error.message || String(error), 'err');
  }
}

async function handleDeleteProduct(sku) {
  const confirmed = await confirmDialog({
    title: 'Excluir produto?',
    message: `O produto <strong>${esc(sku)}</strong> será removido do catálogo. Vendas antigas preservam o histórico.`,
    confirmLabel: 'Excluir',
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/produtos/${encodeURIComponent(sku)}`, { method: 'DELETE' });
  toast('Produto excluído.', 'ok');
  await loadSync();
}
async function handleDeletePerson(id) {
  const person = S.people.find((item) => Number(item.id) === id);
  const confirmed = await confirmDialog({
    title: 'Excluir pessoa?',
    message: `A pessoa <strong>${esc(person?.nome || `#${id}`)}</strong>, o template biométrico e o vínculo de quarto serão removidos.`,
    confirmLabel: 'Excluir',
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/pessoas/${id}`, { method: 'DELETE' });
  toast('Pessoa excluída.', 'ok');
  await loadSync();
  await loadHotel();
}

async function syncWa() {
  try {
    const data = await api('/api/wa/sync', { method: 'POST' });
    toast(`${data.sincronizadas || 0} conversa(s) sincronizada(s).`, 'ok');
    await loadWa();
  } catch (error) {
    toast(error.message, 'err', 6000);
  }
}
async function markWaRead() {
  if (!S.wa.active) return toast('Selecione uma conversa.', 'err');
  try {
    await api(`/api/wa/conversations/${encodeURIComponent(S.wa.active.conversation_id)}/read`, { method: 'POST' });
    const conversation = S.wa.conversations.find((item) => item.conversation_id === S.wa.active.conversation_id);
    if (conversation) conversation.nao_lidas = 0;
    renderWaConversations();
    updateNavBadges();
    toast('Conversa marcada como lida.', 'ok', 1800);
  } catch (error) {
    toast(error.message, 'err');
  }
}
async function toggleWaAi() {
  if (!S.wa.active) return toast('Selecione uma conversa.', 'err');
  try {
    const data = await api(`/api/wa/conversations/${encodeURIComponent(S.wa.active.conversation_id)}/ai`, {
      method: 'POST',
      body: {},
    });
    S.wa.active.ia_ativa = data.ia_ativa ? 1 : 0;
    const conversation = S.wa.conversations.find((item) => item.conversation_id === S.wa.active.conversation_id);
    if (conversation) conversation.ia_ativa = data.ia_ativa ? 1 : 0;
    renderWaHeader();
    renderWaConversations();
    toast(data.ia_ativa ? 'IA ativada nesta conversa.' : 'IA pausada nesta conversa.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}
async function waAiReply() {
  if (!S.wa.active) return toast('Selecione uma conversa.', 'err');
  const button = $('[data-action="wa-ai-reply"]');
  busy(button, true, 'Gerando…');
  try {
    const data = await api(`/api/wa/conversations/${encodeURIComponent(S.wa.active.conversation_id)}/ai-reply`, {
      method: 'POST',
    });
    if (data?.text) {
      toast('Resposta da IA enviada.', 'ok');
      await reloadActiveConversation();
    } else {
      toast(data?.erro || 'A IA não conseguiu responder.', 'err');
    }
  } catch (error) {
    toast(error.message, 'err', 6000);
  } finally {
    busy(button, false);
  }
}

/* ── events ───────────────────────────────────────────── */
function bindAuthForms() {
  $('#loginForm')?.addEventListener('submit', handleLogin);
  $('#registerForm')?.addEventListener('submit', handleRegister);
  $('#forgotForm')?.addEventListener('submit', handleForgot);
  $('#resetForm')?.addEventListener('submit', handleReset);
}
function bindForms() {
  $('#guestForm')?.addEventListener('submit', submitGuest);
  $('#chargeForm')?.addEventListener('submit', submitCharge);
  $('#paymentForm')?.addEventListener('submit', submitPaymentForm);
  $('#waConfigForm')?.addEventListener('submit', saveWaConfig);
  $('#waComposer')?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendWhatsAppMessage();
  });
  $('#changePasswordForm')?.addEventListener('submit', changePassword);
  $('#userTrackForm')?.addEventListener('submit', trackUser);
  $('#userSearch')?.addEventListener('input', debounce(() => renderUsers(S.users), 140));
  ['#registerDoc', '#trackInput'].forEach((selector) => {
    const input = $(selector);
    input?.addEventListener('input', () => {
      input.value = maskDoc(input.value);
    });
  });
  $('#aiForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#aiInput');
    const text = input?.value.trim();
    if (input) input.value = '';
    sendAi(text);
  });
  $('#waInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendWhatsAppMessage();
    }
  });
  $('#waInput')?.addEventListener('input', (event) => {
    const textarea = event.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 110)}px`;
  });
  $('#pdvSearch')?.addEventListener('input', debounce(renderPdvProducts, 120));
  $('#pdvSearch')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = productFilter($('#pdvSearch').value)[0];
      if (first) addToCart(first.sku);
    }
  });
  $('#productSearch')?.addEventListener('input', debounce(renderProducts, 120));
  $('#waSearch')?.addEventListener('input', debounce(renderWaConversations, 150));
  $('#chargeItems')?.addEventListener('change', updateChargeTotal);
  $('#chargeItems')?.addEventListener('input', updateChargeTotal);
  $('#waConfigToggle')?.addEventListener('click', () => {
    const panel = $('#waConfigPanel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#periodTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-period]');
    if (!button) return;
    S.period = Number(button.dataset.period) || 0;
    $$('#periodTabs button').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderReports();
  });
  $('#peopleTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-people-tab]');
    if (!button) return;
    const tab = button.dataset.peopleTab;
    $$('#peopleTabs button').forEach((item) => item.classList.toggle('active', item === button));
    $$('[data-people-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.peoplePane !== tab;
    });
  });
  $('#finalizeBtn')?.addEventListener('click', finalizeSale);
  $('#installBtnConfig')?.addEventListener('click', promptInstall);
  $('#installBtn')?.addEventListener('click', promptInstall);
  $('#sidebarClose')?.addEventListener('click', closeSidebar);
  $('#sidebarBackdrop')?.addEventListener('click', closeSidebar);
  $('#menuBtn')?.addEventListener('click', openSidebar);
}
function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    const reveal = event.target.closest('[data-reveal]');
    if (reveal) {
      const input = document.getElementById(reveal.dataset.reveal);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
      return;
    }
    const authTab = event.target.closest('[data-auth-tab]');
    if (authTab) {
      switchAuthTab(authTab.dataset.authTab);
      return;
    }
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      event.preventDefault();
      navigate(pageButton.dataset.page);
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      event.preventDefault();
      handleAction(actionButton.dataset.action, actionButton);
      return;
    }
    const aiPrompt = event.target.closest('[data-ai-prompt]');
    if (aiPrompt) {
      event.preventDefault();
      sendAi(aiPrompt.dataset.aiPrompt);
      return;
    }
    if (event.target.closest('[data-close-modal]')) {
      closeModal();
      return;
    }
    const aiBackdrop = event.target.closest('[data-ai-backdrop]');
    if (aiBackdrop) closeAi();
  });

  document.addEventListener('change', (event) => {
    const roleSelect = event.target.closest('[data-action="user-role"]');
    if (roleSelect) changeUserRole(roleSelect);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('#modalRoot')?.classList.contains('open')) closeModal();
      else if ($('#aiPanel')?.classList.contains('open')) closeAi();
      else closeSidebar();
    }
    if (event.key === 'F2' && S.page === 'pdv' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      $('#pdvSearch')?.focus();
    }
  });

  window.addEventListener('online', () => {
    setConnection(true);
    toast('Conexão restaurada. Sincronizando fila…', 'ok');
    syncQueue();
    loadDashboardPage();
  });
  window.addEventListener('offline', () => {
    setConnection(false);
    toast('Você está offline. Vendas serão guardadas na fila local.', 'info', 6000);
  });
  window.addEventListener('beforeunload', stopScanner);

  // Health checkpoint periódico (evita indicador "online" mentiroso)
  setInterval(() => {
    if (!S.token || document.hidden) return;
    api('/health', { auth: false, timeout: 8000 })
      .then(() => setConnection(true))
      .catch(() => setConnection(false));
  }, 60000);
}

function setHeroDate() {
  const el = $('#heroDate');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}

document.addEventListener('DOMContentLoaded', init);
