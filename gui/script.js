let accounts = [];
let currentId = null;
let currentMessages = [];
let selectedMsgId = null;
let pollTimer = null;
let settings = { theme: 'dark', sound: true, auto_copy: true, provider: 'mailtm', capsolver_key: '', default_domain: '' };
let domains = [];

const FALLBACK_DOMAINS = ['web-library.net'];

const $ = id => document.getElementById(id);

function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.12);
  } catch (_) {}
}

function setStatus(text, type) {
  const el = $('statusText');
  if (settings.theme === 'cmd') {
    const pfx = type === 'online' ? '[ONLINE] ' : type === 'loading' ? '[BUSY] ' : type === 'error' ? '[ERROR] ' : '';
    el.textContent = pfx + text;
  } else {
    el.textContent = text;
  }
  const dot = $('statusDot');
  dot.className = 'status-dot' + (type ? ' ' + type : '');
}

async function api(method, ...args) {
  try {
    const raw = await pywebview.api[method](...args);
    return JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── Init ───
async function init() {
  const sRes = await api('get_settings');
  if (sRes.ok) Object.assign(settings, sRes.settings);

  document.body.className = 'theme-' + (settings.theme || 'dark');
  const themeSel = $('themeSelect');
  if (themeSel) themeSel.value = settings.theme || 'dark';
  $('soundToggle').checked = settings.sound;
  $('autoCopyToggle').checked = settings.auto_copy;
  $('providerSelect').value = settings.provider;
  $('capsolverInput').value = settings.capsolver_key || '';

  const domRes = await api('get_domains');
  if (domRes.ok && domRes.domains && domRes.domains.length) {
    domains = domRes.domains;
  } else {
    domains = FALLBACK_DOMAINS;
  }
  populateDomainSelects();

  await refreshAll();
  pollTimer = setInterval(poll, 10000);
  setInterval(updateTimers, 30000);
  setStatus('Готов', 'online');
}

function populateDomainSelects() {
  [$('homeDomain'), $('inboxDomain'), $('defaultDomain')].forEach(sel => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">' + (sel.id === 'defaultDomain' ? 'Авто' : 'Любой домен') + '</option>';
    domains.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  });
}

async function refreshAll() {
  await Promise.all([loadAccounts(), loadStats()]);
}

// ─── Accounts ───
async function loadAccounts() {
  const res = await api('list_accounts');
  if (!res.ok) return;
  accounts = res.accounts;
  renderSidebar();
  if (currentId && !accounts.find(a => a.local_id === currentId)) {
    currentId = null;
  }
  if (!currentId && accounts.length) {
    await selectAccount(accounts[0].local_id);
  } else if (currentId) {
    await refreshCurrent();
  } else {
    clearInbox();
  }
  updateStatCounts();
}

function renderSidebar() {
  const list = $('sidebarList');
  list.innerHTML = '';
  const sorted = [...accounts].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.created_at - a.created_at);
  sorted.forEach(a => {
    const div = document.createElement('div');
    div.className = 'acc-circle' + (a.is_current ? ' active' : '') + (a.favorite ? ' fav' : '');
    div.textContent = a.email ? a.email[0].toUpperCase() : '?';
    div.dataset.id = a.local_id;
    div.onclick = () => selectAccount(a.local_id);
    if (a.favorite) {
      const ind = document.createElement('span');
      ind.className = 'fav-indicator';
      ind.textContent = '★';
      div.appendChild(ind);
    }
    const tip = document.createElement('span');
    tip.className = 'circle-tooltip';
    tip.textContent = a.email;
    div.appendChild(tip);
    list.appendChild(div);
  });
}

async function selectAccount(id) {
  currentId = id;
  const res = await api('switch_account', id);
  if (!res.ok) return;
  accounts.forEach(a => a.is_current = (a.local_id === id));
  renderSidebar();
  $('deleteBtn').disabled = false;
  await refreshCurrent();
  await loadMessages();
  setStatus('Готов', 'online');
}

async function refreshCurrent() {
  const res = await api('get_current');
  if (!res.ok) {
    clearInbox();
    return;
  }
  const a = res;
  $('emailAddress').textContent = a.email;
  $('passwordDisplay').textContent = 'Пароль: ' + a.password;
  $('starBtn').className = 'star-btn' + (a.favorite ? ' active' : '');
  updateLifetime(a.created_at);
  $('emailCard').classList.add('active');
}

function clearInbox() {
  $('emailAddress').textContent = '—';
  $('passwordDisplay').textContent = 'Пароль: —';
  $('lifetimeDisplay').textContent = '—';
  $('starBtn').className = 'star-btn';
  $('deleteBtn').disabled = true;
  $('emailCard').classList.remove('active');
  $('messagesList').innerHTML = '<div class="empty-state"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg><p>Выберите аккаунт слева,<br>чтобы видеть письма</p></div>';
  showPreview(null);
}

function updateLifetime(createdAt) {
  const age = Date.now() / 1000 - createdAt;
  const left = Math.max(0, 3600 - age);
  const min = Math.floor(left / 60);
  $('lifetimeDisplay').textContent = '~' + min + ' мин осталось';
}

function updateTimers() {
  if (currentId) {
    const a = accounts.find(x => x.local_id === currentId);
    if (a) updateLifetime(a.created_at || Date.now() / 1000);
  }
}

function updateStatCounts() {
  $('statAccounts').textContent = accounts.length;
  $('statFavs').textContent = accounts.filter(a => a.favorite).length;
}

// ─── Home Stats ───
async function loadStats() {
  const res = await api('get_stats');
  if (!res.ok) return;
  $('statAccounts').textContent = res.total_accounts;
  $('statFavs').textContent = res.favorites;
  $('statMsgs').textContent = res.total_messages;
  const rl = $('recentList');
  if (!res.recent || !res.recent.length) {
    rl.innerHTML = '<div class="recent-empty">Пока нет аккаунтов</div>';
    return;
  }
  rl.innerHTML = res.recent.map(a => `
    <div class="recent-item">
      <div class="ri-icon">${a.email ? a.email[0].toUpperCase() : '?'}</div>
      <div class="ri-info">
        <div class="ri-email">${a.email}</div>
        <div class="ri-meta">${a.age_min} мин назад ${a.favorite ? '★' : ''}</div>
      </div>
    </div>
  `).join('');
}

// ─── Add Account ───
async function addAccount() {
  setStatus('Создание...', 'loading');
  const inInbox = $('page-inbox').classList.contains('active');
  const domainEl = inInbox ? $('inboxDomain') : $('homeDomain');
  const domain = (domainEl && domainEl.value) || settings.default_domain || '';
  const res = await api('add_account_template', '', domain);
  if (!res.ok) { toast(res.error, 'error'); setStatus('Ошибка', 'error'); return; }
  if (settings.auto_copy) copyToClipboard(res.email);
  toast('Создан: ' + res.email, 'success');
  setStatus('Готов', 'online');
  await refreshAll();
  await selectAccount(res.local_id);
}

async function quickTemplate(name) {
  setStatus('Создание...', 'loading');
  const inInbox = $('page-inbox').classList.contains('active');
  const domainEl = inInbox ? $('inboxDomain') : $('homeDomain');
  const domain = (domainEl && domainEl.value) || settings.default_domain || '';
  const res = await api('add_account_template', name, domain);
  if (!res.ok) { toast(res.error, 'error'); setStatus('Ошибка', 'error'); return; }
  if (settings.auto_copy) copyToClipboard(res.email);
  toast('Создан: ' + res.email, 'success');
  setStatus('Готов', 'online');
  await refreshAll();
  await selectAccount(res.local_id);
}

const TEMPLATE_URLS = {
  steam: 'https://store.steampowered.com/join',
  epic: 'https://www.epicgames.com/id/register',
  discord: 'https://discord.com/register',
  github: 'https://github.com/signup',
  twitter: 'https://twitter.com/signup',
  reddit: 'https://www.reddit.com/register',
  amazon: 'https://www.amazon.com/ap/register',
};

async function createAndOpen(name) {
  await quickTemplate(name);
  const url = TEMPLATE_URLS[name] || '';
  if (url) api('open_url', url);
}

async function steamOneClick() {
  await createAndOpen('steam');
}

function onTemplateChange(sel) {
  const btn = $('inboxCreateBtn');
  if (sel.value === 'custom') {
    btn.innerHTML = '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7\"/><path d=\"M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z\"/></svg> Свой...';
  } else if (sel.value) {
    btn.innerHTML = '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 8v8\"/><path d=\"M8 12h8\"/></svg> ' + sel.options[sel.selectedIndex].text;
  } else {
    btn.innerHTML = '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 5v14\"/><path d=\"M5 12h14\"/></svg> Создать';
  }
}

async function createFromInbox() {
  const sel = $('inboxTemplate');
  const val = sel.value;
  if (!val) {
    await addAccount();
  } else if (val === 'custom') {
    customTemplate();
  } else {
    quickTemplate(val);
  }
}

async function customTemplate() {
  showInputModal('Свой префикс', 'Введите префикс для email адреса', '', async value => {
    const clean = value.replace(/[^a-zA-Z0-9_-]/g, '') || 'user';
    await quickTemplate(clean);
  });
}

async function removeCurrentAccount() {
  if (!currentId) return;
  const acc = accounts.find(a => a.local_id === currentId);
  showModal('Удалить аккаунт?', 'Аккаунт <b>' + escapeHtml(acc ? acc.email : '') + '</b> будет удалён безвозвратно.', async () => {
    await api('remove_account', currentId);
    currentId = null;
    toast('Аккаунт удалён', 'success');
    await refreshAll();
  });
}

// ─── Modal ───
function showModal(title, text, onConfirm) {
  $('modalInputWrap').style.display = 'none';
  $('modalText').style.display = 'block';
  $('modalIconWarn').style.display = '';
  $('modalIconEdit').style.display = 'none';
  $('modalIcon').style.color = '';
  $('modalTitle').textContent = title;
  $('modalText').innerHTML = text;
  $('modalCancelBtn').textContent = 'Отмена';
  const btn = $('modalConfirmBtn');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.textContent = 'Удалить';
  newBtn.className = 'btn btn-danger';
  newBtn.addEventListener('click', () => {
    closeModal();
    if (onConfirm) onConfirm();
  });
  $('modalOverlay').classList.add('show');
  setTimeout(() => newBtn.focus(), 100);
}

function showInputModal(title, placeholder, defaultValue, onConfirm) {
  $('modalInputWrap').style.display = 'block';
  $('modalText').style.display = 'none';
  $('modalIconWarn').style.display = 'none';
  $('modalIconEdit').style.display = '';
  $('modalIcon').style.color = 'var(--accent)';
  $('modalTitle').textContent = title;
  const input = $('modalInput');
  input.placeholder = placeholder || '';
  input.value = defaultValue || '';
  const btn = $('modalConfirmBtn');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.textContent = 'Создать';
  newBtn.className = 'btn btn-primary';
  newBtn.addEventListener('click', () => {
    closeModal();
    if (onConfirm) onConfirm(input.value);
  });
  $('modalCancelBtn').textContent = 'Отмена';
  $('modalOverlay').classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 150);
  input.onkeydown = e => {
    if (e.key === 'Enter') { closeModal(); if (onConfirm) onConfirm(input.value); }
  };
}

function closeModal() {
  $('modalOverlay').classList.remove('show');
}

// ─── Copy ───
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function copyEmail() {
  const addr = $('emailAddress').textContent;
  if (addr && addr !== '—') {
    copyToClipboard(addr);
    $('copyBtn').classList.add('copied');
    setTimeout(() => $('copyBtn').classList.remove('copied'), 1200);
    toast('Скопировано', 'success');
  }
}

function copyPreviewText() {
  const body = $('previewBody');
  if (body) {
    copyToClipboard(body.textContent || '');
    toast('Скопировано', 'success');
  }
}

// ─── Favorite ───
async function toggleFavoriteCurrent() {
  if (!currentId) return;
  const res = await api('toggle_favorite', currentId);
  if (!res.ok) return;
  $('starBtn').className = 'star-btn' + (res.favorite ? ' active' : '');
  await refreshAll();
}

// ─── Messages ───
async function loadMessages() {
  const res = await api('get_messages');
  if (!res.ok) {
    $('messagesList').innerHTML = '<div class="empty-state"><p>Нет писем</p></div>';
    $('msgCount').textContent = '0';
    return;
  }
  currentMessages = res.messages;
  $('msgCount').textContent = currentMessages.length;
  if (currentMessages.length === 0) {
    $('messagesList').innerHTML = '<div class="empty-state"><p>Пока нет писем</p></div>';
    showPreview(null);
    return;
  }
  renderMessages();
}

function renderMessages() {
  const list = $('messagesList');
  list.innerHTML = currentMessages.map(m => `
    <div class="msg-item${m.id === selectedMsgId ? ' active' : ''}" data-id="${m.id}" onclick="selectMessage('${m.id}')" oncontextmenu="showCtxMenu(event,'${m.id}','${escapeAttr(m.from_addr)}')">
      <div class="msg-item-top">
        <span class="msg-item-from">${escapeHtml(m.from || m.from_addr || '?')}</span>
        <span class="msg-item-time">${formatTime(m.created_at)}</span>
      </div>
      <div class="msg-item-subject">${escapeHtml(m.subject || '(без темы)')}</div>
      <div class="msg-item-intro">${escapeHtml(m.intro || '')}</div>
    </div>
  `).join('');
  if (!currentMessages.find(m => m.id === selectedMsgId)) {
    showPreview(null);
  }
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escapeAttr(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return h + ':' + m;
  return d.getDate().toString().padStart(2, '0') + '.' + (d.getMonth()+1).toString().padStart(2, '0') + ' ' + h + ':' + m;
}

async function selectMessage(id) {
  selectedMsgId = id;
  renderMessages();
  setStatus('Загрузка...', 'loading');
  const res = await api('get_message', id);
  if (!res.ok) { showPreview(null); setStatus('Ошибка', 'error'); return; }
  showPreview(res);
  setStatus('Готов', 'online');
}

function showPreview(data) {
  const empty = $('previewEmpty');
  const content = $('previewContent');
  if (!data) {
    empty.style.display = 'flex';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';
  $('previewFrom').textContent = (data.from ? data.from + ' ' : '') + '<' + (data.from_addr || '') + '>';
  $('previewSubject').textContent = data.subject || '(без темы)';
  $('previewTime').textContent = formatTime(data.created_at);

  const body = $('previewBody');
  if (data.html) {
    body.innerHTML = data.html;
  } else if (data.text) {
    body.textContent = data.text;
  } else {
    body.textContent = '(пусто)';
  }

  const attArea = $('attachmentsArea');
  const attList = $('attachmentsList');
  if (data.has_attachments && data.attachments && data.attachments.length) {
    attArea.style.display = 'block';
    attList.innerHTML = data.attachments.map(a => {
      const size = a.size > 1024 ? (a.size / 1024).toFixed(1) + ' KB' : a.size + ' B';
      return `<div class="att-item" onclick="downloadAttachment('${selectedMsgId}','${a.id}','${escapeAttr(a.filename)}')">
        <div class="att-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <div class="att-info">
          <div class="att-name">${escapeHtml(a.filename)}</div>
          <div class="att-size">${size}</div>
        </div>
        <svg class="att-dl" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </div>`;
    }).join('');
  } else {
    attArea.style.display = 'none';
  }
}

async function downloadAttachment(msgId, attId, filename) {
  const res = await api('save_attachment', msgId, attId, filename);
  if (res.ok) toast('Сохранено', 'success');
  else if (res.error !== 'Cancelled') toast(res.error, 'error');
}

// ─── Export ───
async function exportMessage(fmt) {
  if (!selectedMsgId) { toast('Выберите письмо', 'error'); return; }
  const res = await api('export_message', selectedMsgId, fmt);
  if (res.ok) toast('Сохранено', 'success');
  else if (res.error !== 'Cancelled') toast(res.error, 'error');
}

// ─── Delete Message ───
async function deleteMessage(id) {
  const res = await api('delete_message', id);
  if (!res.ok) { toast(res.error, 'error'); return; }
  if (selectedMsgId === id) { selectedMsgId = null; showPreview(null); }
  toast('Письмо удалено', 'success');
  await loadMessages();
}

// ─── Context Menu ───
let ctxMsgId = null;
let ctxFromAddr = null;

function showCtxMenu(event, msgId, fromAddr) {
  event.preventDefault();
  ctxMsgId = msgId;
  ctxFromAddr = fromAddr;
  const menu = $('ctxMenu');
  menu.style.display = 'block';
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
}

document.addEventListener('click', () => {
  $('ctxMenu').style.display = 'none';
});

function ctxCopySender() {
  if (ctxFromAddr) copyToClipboard(ctxFromAddr);
  $('ctxMenu').style.display = 'none';
  toast('Скопировано', 'success');
}

function ctxDeleteMessage() {
  if (ctxMsgId) deleteMessage(ctxMsgId);
  $('ctxMenu').style.display = 'none';
}

// ─── Theme ───
function switchTheme(name) {
  document.body.className = 'theme-' + name;
  settings.theme = name;
  saveSetting('theme', name);
}

// ─── Settings ───
async function saveSetting(key, value) {
  settings[key] = value;
  const payload = {};
  const keyMap = { theme: 'theme', sound: 'sound', auto_copy: 'auto_copy', provider: 'provider', capsolver_key: 'capsolver_key', default_domain: 'default_domain' };
  for (const [k, v] of Object.entries(keyMap)) {
    payload[v] = settings[k];
  }
  await api('save_settings', JSON.stringify(payload));
  if (key === 'provider') {
    toast('Провайдер изменён. Новые аккаунты будут создаваться через ' + (value === 'gmx' ? 'GMX' : 'Mail.tm'), 'success');
  }
}

// ─── Page Switching ───
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const pg = $('page-' + page);
  if (pg) pg.classList.add('active');
  const nb = document.querySelector('.nav-btn[data-page="' + page + '"]');
  if (nb) nb.classList.add('active');
  if (page === 'home') loadStats();
  if (page === 'inbox') { loadMessages(); refreshCurrent(); }
}

// ─── Polling ───
let prevMsgCounts = {};

async function poll() {
  if (!currentId) return;
  const res = await api('get_messages');
  if (!res.ok) return;
  if (res.has_new && res.messages.length > (prevMsgCounts[currentId] || 0)) {
    if (settings.sound) playBeep();
    toast('Новое письмо!', 'success');
  }
  prevMsgCounts[currentId] = res.messages.length;
  if (document.querySelector('.page.active#page-inbox')) {
    currentMessages = res.messages;
    $('msgCount').textContent = currentMessages.length;
    renderMessages();
  }
  loadStats();
}

// ─── Dbl-click sidebar to copy email ───
document.addEventListener('dblclick', e => {
  const circle = e.target.closest('.acc-circle');
  if (circle) {
    const id = parseInt(circle.dataset.id);
    const acc = accounts.find(a => a.local_id === id);
    if (acc) { copyToClipboard(acc.email); toast('Скопировано: ' + acc.email, 'success'); }
  }
});

// ─── Init on load ───
document.addEventListener('DOMContentLoaded', init);
