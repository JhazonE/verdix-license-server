/* Vendix LMS dashboard logic (vanilla JS). */

let customersCache = [];
let productsCache = [];
let currentRole = null;
let licensesCache = [];
let activationsCache = [];
let usersCache = [];
let signLicenseId = null;
let editUserId = null;
let pwResetUserId = null;
let _pendingRestoreFile = null;
let _confirmCallback = null;
// Secrets just rotated in this browser session, shown once in a copyable box
// (see regenerateProductWebhookSecret) rather than only in a dismissible toast.
let revealedWebhookSecrets = {};

function matchesQuery(obj, fields, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.some((f) => String(obj[f] == null ? '' : obj[f]).toLowerCase().includes(needle));
}
function setCount(id, shown, total) {
  const el = document.getElementById(id);
  if (el) el.textContent = shown === total ? `(${total})` : `(${shown} of ${total})`;
}

// ── Toast notifications ───────────────────────────────────────────────────────
function toast(message, type = 'info', title = '') {
  const icons = {
    success: '<polyline points="20 6 9 17 4 12"/>',
    error:   '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  };
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[type] || icons.info}</svg>
    <div class="toast-body">${title ? `<strong>${title}</strong>` : ''}${message}</div>`;
  container.appendChild(t);
  const remove = () => { t.classList.add('out'); setTimeout(() => t.remove(), 240); };
  const timer = setTimeout(remove, 4500);
  t.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

// ── Generic confirm dialog ────────────────────────────────────────────────────
function openConfirm({ title, subtitle = '', message, danger = false, confirmLabel = 'Confirm', onConfirm }) {
  _confirmCallback = onConfirm;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-sub').textContent = subtitle;
  document.getElementById('confirm-msg').innerHTML = message;
  const btn = document.getElementById('confirm-ok');
  btn.textContent = confirmLabel;
  btn.className = danger ? 'btn danger' : 'btn';
  const ic = document.getElementById('confirm-ic');
  if (danger) {
    ic.style.background = 'rgba(239,68,68,.15)';
    ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fca5a5" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  } else {
    ic.style.background = 'rgba(99,102,241,.15)';
    ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
  }
  document.getElementById('confirm-modal').classList.add('show');
}
function confirmOk() {
  closeModal('confirm-modal');
  if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
}

// ── Skeleton loaders ──────────────────────────────────────────────────────────
function skeletonStats() {
  return Array.from({ length: 4 }).map(() => `<div class="stat">
      <span class="skel" style="width:38px;height:38px;border-radius:11px;margin-bottom:14px"></span>
      <span class="skel" style="width:54px;height:28px;margin-bottom:8px"></span>
      <span class="skel" style="width:80px"></span>
    </div>`).join('');
}
function skeletonTable(cols, rows = 6) {
  const head = Array.from({ length: cols }).map(() => '<th></th>').join('');
  const body = Array.from({ length: rows }).map(() => `<tr class="skel-row">${
    Array.from({ length: cols }).map((_, i) => `<td><span class="skel" style="width:${i === 0 ? '72%' : '52%'}"></span></td>`).join('')
  }</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('Not authenticated'); }
  return res.json();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s) { return s ? new Date(s).toLocaleDateString() : '—'; }
function relTime(s) {
  if (!s) return 'never';
  const diff = Date.now() - new Date(s).getTime();
  if (diff < 60000) return 'just now';
  const m = Math.floor(diff / 60000); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
  return new Date(s).toLocaleDateString();
}
function isOnline(s) { return s && (Date.now() - new Date(s).getTime()) < 15 * 60000; }
function show(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TAB_META = {
  overview:    ['Overview',             'License management at a glance'],
  customers:   ['Customers',            'Businesses you sell licenses to'],
  products:    ['Products',             'Applications you issue licenses for'],
  licenses:    ['Licenses',             'Issue and manage product keys'],
  activations: ['Activations',          'Machines currently using your licenses'],
  users:       ['Team',                 'Administrators who can access this dashboard'],
  config:      ['System Configuration', 'Backup, restore, and reset license data'],
};
const ALL_TABS = ['overview', 'customers', 'products', 'licenses', 'activations', 'users', 'config'];
function showTab(tab) {
  ALL_TABS.forEach((t) => {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
    const btn = document.querySelector('[data-tab="' + t + '"]');
    if (btn) btn.classList.toggle('active', t === tab);
  });
  const m = TAB_META[tab];
  if (m) { $('page-title').textContent = m[0]; $('page-sub').textContent = m[1]; }
  if (tab === 'overview')    loadStats();
  if (tab === 'customers')   loadCustomers();
  if (tab === 'products')    loadProducts();
  if (tab === 'licenses')    loadLicenses();
  if (tab === 'activations') loadActivations();
  if (tab === 'users')       loadUsers();
}

// ── Overview ──────────────────────────────────────────────────────────────────
async function loadStats() {
  $('stats').innerHTML = skeletonStats();
  const { data } = await api('/api/stats');
  const cards = [
    { n: data.customers,   l: 'Customers',       g: 'linear-gradient(90deg,#6366f1,#8b5cf6)', gb: 'rgba(99,102,241,.15)',  gc: '#a5b4fc',
      ic: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' },
    { n: data.licenses,    l: 'Licenses',         g: 'linear-gradient(90deg,#8b5cf6,#d946ef)', gb: 'rgba(139,92,246,.15)', gc: '#c4b5fd',
      ic: '<path d="M15.5 7.5 19 4M21 2l-2 2M2 22l8.5-8.5"/><circle cx="7.5" cy="15.5" r="5.5"/>' },
    { n: data.activations, l: 'Active Machines',  g: 'linear-gradient(90deg,#10b981,#22c55e)', gb: 'rgba(34,197,94,.15)',  gc: '#86efac',
      ic: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>' },
    { n: data.revoked,     l: 'Revoked',          g: 'linear-gradient(90deg,#ef4444,#f97316)', gb: 'rgba(239,68,68,.15)',  gc: '#fca5a5',
      ic: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>' },
  ];
  $('stats').innerHTML = cards.map((c) => `<div class="stat" style="--g:${c.g};--gb:${c.gb};--gc:${c.gc}">
      <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.ic}</svg></div>
      <div class="n">${c.n}</div><div class="l">${c.l}</div>
    </div>`).join('');
}

// ── Customers ─────────────────────────────────────────────────────────────────
async function loadCustomers() {
  $('customers-table').innerHTML = skeletonTable(6);
  const { data } = await api('/api/customers');
  customersCache = data;
  renderCustomers();
}
function renderCustomers() {
  const el = $('customers-table');
  if (!customersCache.length) { setCount('customers-count', 0, 0); el.innerHTML = '<div class="empty">No customers yet. Click "New Customer".</div>'; return; }
  const q = val('customers-search');
  const data = customersCache.filter((c) => matchesQuery(c, ['business_name', 'contact_name', 'email', 'phone'], q));
  setCount('customers-count', data.length, customersCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No customers match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Business</th><th>Contact</th><th>Email</th><th>Phone</th><th>Licenses</th><th>Added</th></tr></thead><tbody>${
    data.map((c) => `<tr>
      <td><strong>${esc(c.business_name)}</strong></td>
      <td>${esc(c.contact_name) || '—'}</td>
      <td>${esc(c.email) || '—'}</td>
      <td>${esc(c.phone) || '—'}</td>
      <td>${c.license_count}</td>
      <td>${fmtDate(c.created_at)}</td>
    </tr>`).join('')
  }</tbody></table>`;
}
function openCustomerModal() {
  ['c-business','c-contact','c-phone','c-email','c-address','c-notes'].forEach(id => document.getElementById(id).value = '');
  $('c-err').classList.remove('show');
  show('customer-modal');
}
async function saveCustomer() {
  const body = {
    business_name: val('c-business'), contact_name: val('c-contact'), phone: val('c-phone'),
    email: val('c-email'), address: val('c-address'), notes: val('c-notes'),
  };
  const err = $('c-err');
  if (!body.business_name.trim()) { err.textContent = 'Business name is required.'; err.classList.add('show'); return; }
  const res = await api('/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  closeModal('customer-modal');
  loadCustomers();
  toast('Customer added successfully.', 'success', 'Customer Created');
}

// ── Products ──────────────────────────────────────────────────────────────────
async function loadProducts() {
  const el = $('products-table');
  if (el) el.innerHTML = skeletonTable(6);
  const { data } = await api('/api/products');
  productsCache = data || [];
  renderProducts();
}
function productName(id) {
  const p = productsCache.find((x) => x.id === id);
  return p ? p.name : (id || '—');
}
function renderProducts() {
  const el = $('products-table');
  if (!el) return;
  if (!productsCache.length) { setCount('products-count', 0, 0); el.innerHTML = '<div class="empty">No products yet. Click "New Product".</div>'; return; }
  const q = val('products-search');
  const data = productsCache.filter((p) => matchesQuery(p, ['name', 'id', 'key_prefix', 'license_prefix', 'env_key_name'], q));
  setCount('products-count', data.length, productsCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No products match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th></th><th>Name</th><th>ID</th><th>Key Prefix</th><th>License Prefix</th><th>Env Var</th><th>Public Key</th><th>Setup</th></tr></thead><tbody>${
    data.map((p) => {
      const expanded = expandedProducts.has(p.id);
      const cached = setupCache[p.id];
      return `<tr class="expandable" onclick="toggleProductSetup('${esc(p.id)}')">
      <td><span class="chev${expanded ? ' open' : ''}" id="chev-${esc(p.id)}">›</span></td>
      <td><strong>${esc(p.name)}</strong></td>
      <td><code class="key">${esc(p.id)}</code></td>
      <td><code class="key">${esc(p.key_prefix)}</code></td>
      <td><code class="key">${esc(p.license_prefix)}</code></td>
      <td><code class="key">${esc(p.env_key_name)}</code></td>
      <td>${p.public_key
        ? '<span class="pill active">present</span>'
        : '<span class="pill suspended">missing</span>'}</td>
      <td id="setup-pill-${esc(p.id)}">${cached ? setupPillHtml(cached.pill) : '<span class="muted" style="font-size:12px">—</span>'}</td>
    </tr>
    <tr class="detail${expanded ? '' : ' hidden'}" id="detail-${esc(p.id)}"><td colspan="8"><div id="setup-${esc(p.id)}">${expanded && cached ? renderSetupPanel(cached) : ''}</div></td></tr>`;
    }).join('')
  }</tbody></table>`;
}
// ── New Product: derive everything from the name ──────────────────────────────
// Registering a product used to mean inventing four values by hand (id, two
// prefixes, an env var name) with the rules explained in one paragraph below the
// fields. All four are derivable from the name, so we generate them, show what
// they actually produce, and check prefix availability BEFORE submitting —
// createProduct rejects duplicate prefixes, and the prefixes are UNIQUE columns,
// so a clash discovered after saving is annoying to undo.
let _productFieldsEdited = false;

/** Lowercase, dash-separated id. Mirrors createProduct's /^[a-z0-9][a-z0-9-]*$/. */
function slugifyProductId(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

/**
 * 4-letter key prefix from the name's words: initials when there are several
 * (Verdix Inventory -> VINV uses first letter + 3 of the last word), otherwise
 * the first four letters. Falls back to padding so the result is always 2-4
 * chars of A-Z0-9, which is what the product-key format expects.
 */
function suggestKeyPrefix(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let p = words.length === 1
    ? words[0].slice(0, 4)
    : (words[0][0] + words[words.length - 1].slice(0, 3));
  return p.replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

/** Env var name: LICENSE_PRIVATE_KEY_<PREFIX>. Column is VARCHAR(64). */
function suggestEnvKey(keyPrefix) {
  return ('LICENSE_PRIVATE_KEY_' + String(keyPrefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 64);
}

/** First prefix not already taken, trying PREFIX, PREFI2, PREFI3… */
function firstFreeKeyPrefix(base) {
  if (!base) return '';
  const taken = new Set(productsCache.map((p) => (p.key_prefix || '').toUpperCase()));
  const takenLic = new Set(productsCache.map((p) => (p.license_prefix || '').toUpperCase()));
  if (!taken.has(base) && !takenLic.has(base + '1')) return base;
  for (let n = 2; n <= 9; n++) {
    const cand = (base.slice(0, 3) + n);
    if (!taken.has(cand) && !takenLic.has(cand + '1')) return cand;
  }
  return base; // give up; the availability line will flag the clash
}

function onProductNameInput() {
  // Once the operator edits a generated field by hand, stop overwriting it.
  if (_productFieldsEdited) { renderProductPreview(); return; }
  const name = val('p-name');
  const keyPrefix = firstFreeKeyPrefix(suggestKeyPrefix(name));
  $('p-id').value = slugifyProductId(name);
  $('p-key-prefix').value = keyPrefix;
  $('p-license-prefix').value = keyPrefix ? keyPrefix + '1' : '';
  $('p-env-key').value = keyPrefix ? suggestEnvKey(keyPrefix) : '';
  renderProductPreview();
}

function onProductFieldEdited() {
  _productFieldsEdited = true;
  renderProductPreview();
}

function renderProductPreview() {
  const id = val('p-id'), kp = val('p-key-prefix').toUpperCase(), lp = val('p-license-prefix').toUpperCase();
  $('pv-id').textContent  = id || '—';
  $('pv-key').textContent = kp ? `${kp}-XXXX-XXXX-XXXX` : '—';
  $('pv-lic').textContent = lp ? `${lp}.<payload>.<signature>` : '—';
  $('pv-env').textContent = val('p-env-key') || '—';

  // Report the same conflicts createProduct would reject, before submitting.
  const el = $('p-avail');
  el.className = 'genstatus';
  if (!kp && !lp && !id) { el.textContent = ''; return; }
  const problems = [];
  if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push('Product ID must be lowercase letters, digits and dashes.');
  const idClash = productsCache.find((p) => p.id === id);
  if (idClash) problems.push(`Product ID "${id}" already exists.`);
  const kClash = productsCache.find((p) => (p.key_prefix || '').toUpperCase() === kp);
  if (kp && kClash) problems.push(`Key prefix ${kp} is used by "${kClash.id}".`);
  const lClash = productsCache.find((p) => (p.license_prefix || '').toUpperCase() === lp);
  if (lp && lClash) problems.push(`License prefix ${lp} is used by "${lClash.id}".`);

  if (problems.length) {
    el.classList.add('bad');
    el.textContent = '⚠ ' + problems.join(' ');
  } else if (kp && lp && id) {
    el.classList.add('ok');
    el.textContent = `✓ ${kp} and ${lp} are available`;
  } else {
    el.textContent = '';
  }
}

function toggleProductAdvanced() {
  const box = $('p-advanced');
  const chev = $('p-adv-chev');
  const opening = box.classList.contains('hidden');
  box.classList.toggle('hidden', !opening);
  if (chev) chev.classList.toggle('open', opening);
}

function openProductModal() {
  ['p-id','p-name','p-key-prefix','p-license-prefix','p-env-key'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  _productFieldsEdited = false;
  $('p-advanced').classList.add('hidden');
  $('p-adv-chev').classList.remove('open');
  renderProductPreview();
  $('p-err').classList.remove('show');
  show('product-modal');
}
async function saveProduct() {
  const body = {
    id: val('p-id'), name: val('p-name'), key_prefix: val('p-key-prefix'),
    license_prefix: val('p-license-prefix'), env_key_name: val('p-env-key'),
  };
  const err = $('p-err');
  err.classList.remove('show');
  if (!body.name.trim()) {
    err.textContent = 'Product name is required.'; err.classList.add('show'); return;
  }
  // The rest are normally generated from the name, so point at what to fix
  // rather than naming fields that are collapsed under Advanced.
  if (!body.id.trim() || !body.key_prefix.trim() || !body.license_prefix.trim() || !body.env_key_name.trim()) {
    err.textContent = 'Could not derive all values from that name — open Advanced and fill them in.';
    err.classList.add('show');
    $('p-advanced').classList.remove('hidden');
    return;
  }
  const res = await api('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  closeModal('product-modal');
  loadProducts();
  toast('Product added successfully.', 'success', 'Product Created');
}

// ── Product setup checklist ───────────────────────────────────────────────────
// The four setup steps are not equally knowable. Three are derived from server
// state; embedding the public key happens in the product's own repo, so the
// operator marks it and the mark is bound to the key's fingerprint.
const setupCache = {};
const expandedProducts = new Set();

async function toggleProductSetup(id) {
  const row = $('detail-' + id);
  const chev = $('chev-' + id);
  if (!row) return;
  const opening = row.classList.contains('hidden');
  row.classList.toggle('hidden', !opening);
  if (chev) chev.classList.toggle('open', opening);
  if (opening) expandedProducts.add(id); else expandedProducts.delete(id);
  if (!opening) return;

  const panel = $('setup-' + id);
  if (setupCache[id]) {
    panel.innerHTML = renderSetupPanel(setupCache[id]);
    renderSetupPill(id, setupCache[id].pill);
    return;
  }
  panel.innerHTML = '<div class="setup"><span class="muted">Loading setup status…</span></div>';
  await loadProductSetup(id);
}

async function loadProductSetup(id) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/setup');
  if (!res.success) {
    $('setup-' + id).innerHTML = `<div class="setup"><span class="muted">${esc(res.error || 'Could not load setup status.')}</span></div>`;
    return;
  }
  setupCache[id] = res.data;
  $('setup-' + id).innerHTML = renderSetupPanel(res.data);
  renderSetupPill(id, res.data.pill);
}

function setupPillHtml(pill) {
  const map = {
    'ready':       ['active',    'Ready'],
    'needs-setup': ['suspended', 'Needs setup'],
    'stale':       ['stale',     'Stale'],
  };
  const [cls, label] = map[pill] || ['suspended', 'Unknown'];
  return `<span class="pill ${cls}">${label}</span>`;
}

function renderSetupPill(id, pill) {
  const cell = $('setup-pill-' + id);
  if (!cell) return;
  cell.innerHTML = setupPillHtml(pill);
}

function copyBtn(text, label) {
  // Base64 so quotes/newlines in the value can't break out of the attribute.
  return `<button class="btn ghost sm" onclick="event.stopPropagation();copyValue('${btoa(unescape(encodeURIComponent(text)))}','${esc(label)}')">copy</button>`;
}

async function copyValue(b64, label) {
  try {
    await navigator.clipboard.writeText(decodeURIComponent(escape(atob(b64))));
    toast(label + ' copied to clipboard.', 'success');
  } catch {
    toast('Could not copy to clipboard.', 'error');
  }
}

function renderSetupPanel(d) {
  const s = d.steps;

  // Step 1 — always satisfied; the row exists because it's registered.
  const step1 = `<div class="setup-step">
    <span class="mark ok">✓</span>
    <div><h4>1. Registered</h4>
      <div class="note"><code class="key">${esc(d.productId)}</code> · product keys look like <code class="key">${esc(d.keyPrefix)}-XXXX-XXXX-XXXX</code></div></div>
  </div>`;

  // Step 2 — a stored public key means keygen ran for this product.
  const step2 = s.keypair.ok
    ? `<div class="setup-step">
        <span class="mark ok">✓</span>
        <div><h4>2. Signing keypair</h4>
          <div class="note">Public key stored on the product row.</div></div>
      </div>`
    : `<div class="setup-step">
        <span class="mark bad">✗</span>
        <div><h4>2. Signing keypair</h4>
          <div class="note">No keypair yet. Run this, then reopen this panel:</div>
          <pre>npm run keygen -- --product ${esc(d.productId)}</pre>
          <div class="copyrow">${copyBtn('npm run keygen -- --product ' + d.productId, 'Command')}</div></div>
      </div>`;

  // Step 3 — operator-marked. All three verifier overrides are shown together
  // because each one, if missed, fails silently: a wrong prefix reports
  // malformed-key and a wrong product id reports wrong-product.
  const embedHead = {
    done:    ['ok',   '✓', `Marked by ${esc(s.embed.by || '—')} · ${s.embed.at ? fmtDate(s.embed.at) : '—'}`],
    pending: ['todo', '→', 'You must do this in the product\'s own repo — the server cannot verify it.'],
    stale:   ['bad',  '⚠', `STALE — the key changed since this was marked${s.embed.by ? ` by ${esc(s.embed.by)} · ${fmtDate(s.embed.at)}` : ''}. Re-embed the key below.`],
  }[s.embed.state];

  const keyBlock = d.publicKey
    ? `<pre>${esc(d.publicKey.trim())}</pre>
       <div class="copyrow"><span class="lbl">public key</span>${copyBtn(d.publicKey.trim(), 'Public key')}</div>`
    : '<div class="note">No public key yet — complete step 2 first.</div>';

  const step3 = `<div class="setup-step">
    <span class="mark ${embedHead[0]}">${embedHead[1]}</span>
    <div><h4>3. Embed the public key in your app</h4>
      <div class="note">${embedHead[2]}</div>
      ${keyBlock}
      <div class="note" style="margin-top:12px">Your verifier must override <strong>all three</strong>:</div>
      <div class="copyrow"><span class="lbl">product id</span><code class="key">${esc(d.productId)}</code>${copyBtn(d.productId, 'Product id')}</div>
      <div class="copyrow"><span class="lbl">license prefix</span><code class="key">${esc(d.licensePrefix)}</code>${copyBtn(d.licensePrefix, 'License prefix')}</div>
      <div class="copyrow"><span class="lbl">public key</span><span class="note">shown above</span></div>
      ${d.publicKey ? `<div class="copyrow" style="margin-top:12px">
        ${s.embed.state === 'done'
          ? `<button class="btn ghost sm" onclick="event.stopPropagation();markEmbedded('${esc(d.productId)}',false)">Unmark</button>`
          : `<button class="btn sm" onclick="event.stopPropagation();markEmbedded('${esc(d.productId)}',true)">${s.embed.state === 'stale' ? 'Re-mark as embedded' : '✓ Mark as embedded'}</button>`}
      </div>` : ''}
    </div>
  </div>`;

  // Step 4 — names the source rather than claiming "deployed", because this
  // only describes the server you're talking to right now.
  // keyFile comes from the server, which knows verdix-pos uses the flat
  // keys/private-key.pem; deriving keys/<id>/ here would name a missing file.
  const keyFile = d.keyFile || `keys/${d.productId}/private-key.pem`;
  const srcNote = {
    'env':        ['ok',   '✓', `Resolved from <code class="key">${esc(d.envKeyName)}</code> — the production path.`],
    'local-file': ['warn', '⚠', `Resolved from <code class="key">${esc(keyFile)}</code> only. This dashboard can't see your Railway environment, so a production deploy is <strong>not</strong> confirmed.`],
    'none':       ['bad',  '✗', 'No signing key found. Complete step 2, or set the env var below.'],
  }[s.signing.source];

  const step4 = `<div class="setup-step">
    <span class="mark ${srcNote[0]}">${srcNote[1]}</span>
    <div><h4>4. Deploy the private key</h4>
      <div class="note">${srcNote[2]}</div>
      <div class="copyrow"><span class="lbl">env var</span><code class="key">${esc(d.envKeyName)}</code>${copyBtn(d.envKeyName, 'Env var name')}</div>
      <div class="note">Set it to the contents of <code class="key">${esc(keyFile)}</code>. Never commit it.</div></div>
  </div>`;

  // Step 5 — optional. Not part of the deploy-readiness pill; a product is
  // "ready" without a webhook configured, so this is styled as a separate
  // section rather than a numbered step with a pass/fail mark.
  const webhookSection = `<div class="setup-step" style="border-top:1px solid var(--border,#333);margin-top:12px;padding-top:12px">
    <span class="mark ${d.webhookUrl ? 'ok' : 'todo'}">${d.webhookUrl ? '✓' : '→'}</span>
    <div style="flex:1">
      <h4>Webhook</h4>
      <div class="note">POST license events to your own system: license.activated, license.status_changed, license.issued, license.revoked, license.reactivated, customer.created. See the app integration guide for payload format.</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="webhook-url-${esc(d.productId)}" type="text" placeholder="https://your-system.example/webhook"
               value="${esc(d.webhookUrl || '')}" style="flex:1" onclick="event.stopPropagation()">
        <button class="btn ghost sm" onclick="event.stopPropagation();saveProductWebhook('${esc(d.productId)}')">save</button>
      </div>
      ${d.hasWebhookSecret ? `<div style="margin-top:8px"><span class="muted" style="font-size:12px">Secret configured.</span> <button class="btn ghost sm" onclick="event.stopPropagation();regenerateProductWebhookSecret('${esc(d.productId)}')">regenerate secret</button></div>` : ''}
      ${revealedWebhookSecrets[d.productId] ? `<div class="copyrow" style="margin-top:8px"><span class="lbl">new secret (shown once)</span><code class="key">${esc(revealedWebhookSecrets[d.productId])}</code>${copyBtn(revealedWebhookSecrets[d.productId], 'Webhook secret')}</div>` : ''}
    </div>
  </div>`;

  return `<div class="setup">${step1}${step2}${step3}${step4}${webhookSection}</div>`;
}

async function markEmbedded(id, marked) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marked }),
  });
  if (!res.success) { toast(res.error || 'Could not update the mark.', 'error'); return; }
  delete setupCache[id];
  await loadProductSetup(id);
  toast(marked ? 'Marked as embedded.' : 'Mark cleared.', 'success');
}

async function saveProductWebhook(id) {
  const url = val('webhook-url-' + id);
  const res = await api('/api/products/' + encodeURIComponent(id) + '/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.trim() || null }),
  });
  if (!res.success) { toast(res.error, 'error'); return; }
  toast(res.data.webhook_url ? 'Webhook saved.' : 'Webhook cleared.', 'success');
  delete setupCache[id];
  await loadProductSetup(id);
}

async function regenerateProductWebhookSecret(id) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerateSecret: true }),
  });
  if (!res.success) { toast(res.error, 'error'); return; }
  // Shown once in a copyable box in the panel (see renderSetupPanel) — the
  // secret can't be retrieved again after this, so a toast alone (not
  // copyable, may auto-dismiss) isn't good enough for it.
  revealedWebhookSecrets[id] = res.data.webhook_secret;
  toast('Webhook secret rotated. Copy it now — it will not be shown again.', 'success', 'Webhook Secret Rotated');
  delete setupCache[id];
  await loadProductSetup(id);
}

// ── Licenses ──────────────────────────────────────────────────────────────────
async function loadLicenses() {
  $('licenses-table').innerHTML = skeletonTable(9);
  if (!productsCache.length) { try { await loadProducts(); } catch {} }
  const { data } = await api('/api/licenses');
  licensesCache = data;
  renderLicenseProductFilter();
  renderLicenses();
}
function renderLicenseProductFilter() {
  const sel = $('licenses-product-filter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">All products</option>' +
    productsCache.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = current;
}
function renderLicenses() {
  const el = $('licenses-table');
  if (!licensesCache.length) { setCount('licenses-count', 0, 0); el.innerHTML = '<div class="empty">No licenses yet. Click "Issue License".</div>'; return; }
  const q = val('licenses-search');
  const productFilter = val('licenses-product-filter');
  const data = licensesCache
    .filter((l) => !productFilter || l.product_id === productFilter)
    .filter((l) => matchesQuery(l, ['product_key', 'business_name', 'edition', 'status', 'type', 'product_id'], q));
  setCount('licenses-count', data.length, licensesCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No licenses match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Product Key</th><th>Product</th><th>Customer</th><th>Edition</th><th>Type</th><th>Expires</th><th>Computers</th><th>Status</th><th></th></tr></thead><tbody>${
    data.map((l) => `<tr>
      <td><code class="key">${esc(l.product_key)}</code></td>
      <td>${esc(productName(l.product_id))}</td>
      <td>${esc(l.business_name)}</td>
      <td>${esc(l.edition)}</td>
      <td><span class="pill ${l.type}">${l.type}</span></td>
      <td>${l.type === 'subscription' ? fmtDate(l.expires_at) : '—'}</td>
      <td>${l.active_count}/${l.max_activations}</td>
      <td><span class="pill ${l.status}">${l.status}</span></td>
      <td style="white-space:nowrap">
        <button class="btn sm" onclick="openSignModal('${l.id}','${esc(l.product_key)}','${esc(l.business_name)}')">Generate Key</button>
        ${l.status === 'active'
          ? `<button class="btn sm danger" onclick="setStatus('${l.id}','revoked')">Revoke</button>`
          : `<button class="btn sm ghost" onclick="setStatus('${l.id}','active')">Reactivate</button>`}
      </td>
    </tr>`).join('')
  }</tbody></table>`;
}
function toggleExpiry() {
  $('l-expiry-wrap').classList.toggle('hidden', val('l-type') !== 'subscription');
}
function openLicenseModal() {
  if (!customersCache.length) {
    toast('Please create a customer first before issuing a license.', 'warning', 'No Customers');
    return;
  }
  $('l-customer').innerHTML = customersCache.map((c) => `<option value="${c.id}">${esc(c.business_name)}</option>`).join('');
  const active = productsCache.filter((p) => p.status !== 'inactive');
  $('l-product').innerHTML = active.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.key_prefix)})</option>`).join('');
  if (active.some((p) => p.id === 'verdix-pos')) $('l-product').value = 'verdix-pos';
  $('l-edition').value = 'standard'; $('l-type').value = 'perpetual'; $('l-days').value = ''; $('l-expires').value = '';
  $('l-seats').value = '1'; $('l-features').value = ''; $('l-notes').value = '';
  $('l-err').classList.remove('show');
  toggleExpiry();
  show('license-modal');
}
async function saveLicense() {
  const type = val('l-type');
  const body = {
    customer_id: val('l-customer'), product_id: val('l-product') || undefined,
    edition: val('l-edition'), type,
    max_activations: parseInt(val('l-seats') || '1', 10),
    features: val('l-features').split(',').map((f) => f.trim()).filter(Boolean),
    notes: val('l-notes'),
  };
  if (type === 'subscription') {
    if (val('l-expires')) body.expires_at = val('l-expires');
    else if (val('l-days')) body.expires_at = new Date(Date.now() + parseInt(val('l-days'), 10) * 86400000).toISOString();
  }
  const err = $('l-err');
  if (type === 'subscription' && !body.expires_at) { err.textContent = 'Set a duration or expiry date.'; err.classList.add('show'); return; }
  const res = await api('/api/licenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  closeModal('license-modal');
  loadLicenses();
  $('issued-product-key').textContent = res.data.product_key;
  $('issued-copy-btn').textContent = 'Copy Key';
  show('license-issued-modal');
}
async function copyIssuedKey() {
  try {
    await navigator.clipboard.writeText($('issued-product-key').textContent);
    $('issued-copy-btn').textContent = '✓ Copied';
    setTimeout(() => $('issued-copy-btn').textContent = 'Copy Key', 1500);
  } catch {}
}
function openCloudCustomerModal() {
  if (!customersCache.length) { alert('Create a customer first.'); return; }
  $('cc-customer').innerHTML = customersCache.map((c) => `<option value="${c.id}">${esc(c.business_name)}</option>`).join('');
  const active = productsCache.filter((p) => p.status !== 'inactive');
  $('cc-product').innerHTML = active.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (active.some((p) => p.id === 'verdix-pos')) $('cc-product').value = 'verdix-pos';
  $('cc-edition').value = 'web';
  $('cc-seats').value = '1';
  $('cc-expires').value = '';
  $('cc-features').value = 'cloud-sync';
  $('cc-provision').checked = true;
  $('cc-err').classList.remove('show');
  $('cc-steps').innerHTML = '';
  $('cc-env-wrap').style.display = 'none';
  $('cc-copy').style.display = 'none';
  $('cc-submit').style.display = '';
  show('cloud-customer-modal');
}
async function submitCloudCustomer() {
  const err = $('cc-err');
  err.classList.remove('show');
  const expires = val('cc-expires');
  if (!expires) { err.textContent = 'Set an expiry date.'; err.classList.add('show'); return; }

  const body = {
    customer_id: val('cc-customer'),
    product_id: val('cc-product') || undefined,
    edition: val('cc-edition'),
    type: 'subscription',
    expires_at: new Date(expires + 'T23:59:59').toISOString(),
    max_activations: parseInt(val('cc-seats') || '1', 10),
    features: val('cc-features').split(',').map((f) => f.trim()).filter(Boolean),
    provision_database: $('cc-provision').checked,
  };

  $('cc-submit').disabled = true;
  $('cc-steps').innerHTML = '<p class="muted" style="font-size:13px">Working…</p>';

  const res = await api('/api/cloud-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  $('cc-submit').disabled = false;

  if (!res.success) {
    $('cc-steps').innerHTML = '';
    err.textContent = res.error || 'Failed.';
    err.classList.add('show');
    return;
  }

  const d = res.data;
  const row = (ok, label, detail) =>
    `<div style="display:flex;gap:8px;font-size:13px;margin-bottom:6px">
       <span style="color:${ok ? '#86efac' : '#fca5a5'}">${ok ? '✓' : '✕'}</span>
       <span>${esc(label)}</span>
       <span class="muted" style="word-break:break-all">${esc(detail || '')}</span>
     </div>`;

  // When d.env is absent, the env block (which normally carries the full token)
  // won't be shown — so if the token was minted, show it in full here instead of
  // truncating it, or it becomes unrecoverable from the UI and the operator has
  // to re-mint via CLI, creating a second activation row.
  const tokenDetail = d.token.ok
    ? (d.env ? d.token.signedLicense.slice(0, 24) + '…' : d.token.signedLicense)
    : (d.token.error || '');

  $('cc-steps').innerHTML =
    row(d.license.ok, 'Licence created', d.license.product_key) +
    row(d.database.ok, d.database.skipped ? 'Database skipped' : 'Database provisioned',
        d.database.ok ? d.database.name : (d.database.error || '')) +
    row(d.token.ok, 'Hosted token minted', tokenDetail);

  // Provisioning genuinely failed (not just skipped) — give the operator the exact
  // CLI command to finish the job by hand, per the spec's Error handling section.
  if (!d.database.ok && !d.database.skipped) {
    $('cc-steps').innerHTML +=
      `<div style="margin-top:12px"><p class="muted" style="font-size:12px">Finish provisioning by hand:</p>` +
      `<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px">npm run provision-cloud -- --license ${esc(d.license.product_key)}</pre></div>`;
  }

  if (d.env_warning) {
    $('cc-steps').innerHTML +=
      `<div style="margin-top:12px" class="err show">${esc(d.env_warning)}</div>`;
  }

  if (d.env) {
    $('cc-env').textContent = Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n');
    $('cc-env-wrap').style.display = '';
    $('cc-copy').style.display = '';
    $('cc-submit').style.display = 'none';
  }

  loadLicenses();
}
async function copyCloudEnv() {
  try {
    await navigator.clipboard.writeText($('cc-env').textContent);
    $('cc-copy').textContent = '✓ Copied';
    setTimeout(() => { $('cc-copy').textContent = 'Copy Env Block'; }, 1500);
  } catch {}
}
async function setStatus(id, status) {
  if (status === 'revoked') {
    openConfirm({
      title: 'Revoke License',
      subtitle: 'Online machines will be blocked on next check',
      message: 'POS machines using this license will lose access the next time they check in. You can reactivate the license later to restore access.',
      danger: true,
      confirmLabel: 'Revoke License',
      onConfirm: async () => {
        const res = await api('/api/licenses/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        if (!res.success) { toast(res.error, 'error', 'Error'); return; }
        loadLicenses();
        toast('License revoked. Machines will be blocked on next check.', 'warning', 'License Revoked');
      },
    });
    return;
  }
  const res = await api('/api/licenses/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  if (!res.success) { toast(res.error, 'error', 'Error'); return; }
  loadLicenses();
  toast('License is now active.', 'success', 'License Reactivated');
}

// ── Sign (offline key generation) ─────────────────────────────────────────────
function openSignModal(licenseId, productKey, business) {
  signLicenseId = licenseId;
  $('sign-context').textContent = business + ' • ' + productKey;
  $('s-machine').value = ''; $('s-label').value = '';
  $('s-err').classList.remove('show');
  $('s-keyout').classList.add('hidden');
  $('s-gen-btn').classList.remove('hidden');
  $('s-copy-btn').classList.add('hidden');
  show('sign-modal');
}
async function generateKey() {
  const err = $('s-err');
  err.classList.remove('show');
  if (!val('s-machine').trim()) { err.textContent = 'Machine ID is required.'; err.classList.add('show'); return; }
  const res = await api('/api/licenses/' + signLicenseId + '/sign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineId: val('s-machine'), machineLabel: val('s-label') }),
  });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  $('s-key').textContent = res.data.signedLicense;
  $('s-keyout').classList.remove('hidden');
  $('s-gen-btn').classList.add('hidden');
  $('s-copy-btn').classList.remove('hidden');
}
async function copyKey() {
  try {
    await navigator.clipboard.writeText($('s-key').textContent);
    const b = $('s-copy-btn'); b.textContent = '✓ Copied'; setTimeout(() => b.textContent = 'Copy Key', 1500);
  } catch {}
}

// ── Activations ───────────────────────────────────────────────────────────────
async function loadActivations() {
  $('activations-table').innerHTML = skeletonTable(8);
  const { data } = await api('/api/activations');
  activationsCache = data;
  renderActivations();
}
function renderActivations() {
  const el = $('activations-table');
  if (!activationsCache.length) { setCount('activations-count', 0, 0); el.innerHTML = '<div class="empty">No activations yet.</div>'; return; }
  const q = val('activations-search');
  const data = activationsCache.filter((a) => matchesQuery(a, ['business_name', 'product_key', 'machine_id', 'machine_label', 'status'], q));
  setCount('activations-count', data.length, activationsCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No activations match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Customer</th><th>Product Key</th><th>Machine</th><th>Label</th><th>Status</th><th>Last Seen</th><th>Activated</th><th></th></tr></thead><tbody>${
    data.map((a) => `<tr>
      <td>${esc(a.business_name)}</td>
      <td><code class="key">${esc(a.product_key)}</code></td>
      <td><code class="key">${esc(a.machine_id).slice(0,20)}…</code></td>
      <td>${esc(a.machine_label) || '—'}</td>
      <td><span class="pill ${a.status === 'active' ? 'active' : 'suspended'}">${a.status}</span></td>
      <td><span style="display:inline-flex;align-items:center;gap:7px">
        <span title="${isOnline(a.last_seen_at) ? 'Online' : 'Offline'}" style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${isOnline(a.last_seen_at) ? '#22c55e' : '#475569'};${isOnline(a.last_seen_at) ? 'box-shadow:0 0 7px #22c55e' : ''}"></span>
        ${relTime(a.last_seen_at)}</span></td>
      <td>${fmtDate(a.activated_at)}</td>
      <td>${a.status === 'active' ? `<button class="btn sm danger" onclick="release('${a.id}')">Release</button>` : ''}</td>
    </tr>`).join('')
  }</tbody></table>`;
}
async function release(id) {
  openConfirm({
    title: 'Release Seat',
    subtitle: 'The machine will need to re-activate',
    message: 'This machine will lose access until it re-activates. Use this to move a license to a different computer.',
    danger: true,
    confirmLabel: 'Release Seat',
    onConfirm: async () => {
      const res = await api('/api/activations/' + id + '/release', { method: 'POST' });
      if (!res.success) { toast(res.error, 'error', 'Error'); return; }
      loadActivations();
      toast('Seat released. The machine will need to re-activate.', 'info', 'Seat Released');
    },
  });
}

// ── Users / Team ──────────────────────────────────────────────────────────────
async function loadUsers() {
  $('users-table').innerHTML = skeletonTable(5);
  const { data } = await api('/api/users');
  usersCache = data || [];
  renderUsers();
}
function renderUsers() {
  const el = $('users-table');
  if (!usersCache.length) { setCount('users-count', 0, 0); el.innerHTML = '<div class="empty">No users yet.</div>'; return; }
  const q = val('users-search');
  const data = usersCache.filter((u) => matchesQuery(u, ['username', 'role'], q));
  setCount('users-count', data.length, usersCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No users match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Last Login</th><th></th></tr></thead><tbody>${
    data.map((u) => `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td><span class="pill perpetual">${esc(u.role)}</span></td>
      <td>${fmtDate(u.created_at)}</td>
      <td>${u.last_login_at ? fmtDate(u.last_login_at) : '—'}</td>
      <td style="white-space:nowrap">
        <button class="btn sm ghost" onclick="openEditUser('${u.id}')">Edit</button>
        <button class="btn sm ghost" onclick="resetUserPassword('${u.id}','${esc(u.username)}')">Reset Password</button>
        <button class="btn sm danger" onclick="deleteUser('${u.id}','${esc(u.username)}')">Delete</button>
      </td>
    </tr>`).join('')
  }</tbody></table>`;
}
function openUserModal() {
  editUserId = null;
  $('u-title').textContent = 'New User';
  $('u-subtitle').textContent = 'Create a dashboard login';
  $('u-pass-hint').textContent = '* (min 6 characters)';
  $('u-save-btn').textContent = 'Create User';
  $('u-username').value = ''; $('u-password').value = ''; $('u-role').value = 'admin';
  $('u-password').placeholder = '';
  $('u-err').classList.remove('show');
  show('user-modal');
}
function openEditUser(id) {
  const u = usersCache.find((x) => x.id === id);
  if (!u) return;
  editUserId = id;
  $('u-title').textContent = 'Edit User';
  $('u-subtitle').textContent = 'Update username, role or password';
  $('u-pass-hint').textContent = '(leave blank to keep current)';
  $('u-save-btn').textContent = 'Save Changes';
  $('u-username').value = u.username;
  $('u-role').value = u.role;
  $('u-password').value = '';
  $('u-password').placeholder = '••••••••';
  $('u-err').classList.remove('show');
  show('user-modal');
}
async function saveUser() {
  const username = val('u-username');
  const password = val('u-password');
  const role = val('u-role');
  const err = $('u-err'); err.classList.remove('show');
  if (!username.trim()) { err.textContent = 'Username is required.'; err.classList.add('show'); return; }
  if (!editUserId && password.length < 6) { err.textContent = 'A password of at least 6 characters is required.'; err.classList.add('show'); return; }
  if (password && password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.classList.add('show'); return; }
  const url = editUserId ? '/api/users/' + editUserId : '/api/users';
  const body = editUserId ? { username, role, ...(password ? { password } : {}) } : { username, password, role };
  const res = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  closeModal('user-modal');
  loadUsers();
  toast(editUserId ? 'User updated.' : 'User created.', 'success');
}
function resetUserPassword(id, username) {
  pwResetUserId = id;
  $('pw-for').textContent = 'Updating password for: ' + username;
  $('pw-input').value = '';
  $('pw-err').classList.remove('show');
  show('pw-modal');
  setTimeout(() => $('pw-input').focus(), 320);
}
async function savePw() {
  const pw = val('pw-input');
  const err = $('pw-err');
  err.classList.remove('show');
  if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.classList.add('show'); return; }
  const res = await api('/api/users/' + pwResetUserId + '/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  if (!res.success) { err.textContent = res.error; err.classList.add('show'); return; }
  closeModal('pw-modal');
  toast('Password updated successfully.', 'success', 'Password Updated');
}
async function deleteUser(id, username) {
  openConfirm({
    title: 'Delete User',
    subtitle: `"${username}" will lose dashboard access`,
    message: `This will permanently remove <strong>${esc(username)}</strong> from the dashboard. This cannot be undone.`,
    danger: true,
    confirmLabel: 'Delete User',
    onConfirm: async () => {
      const res = await api('/api/users/' + id + '/delete', { method: 'POST' });
      if (!res.success) { toast(res.error, 'error', 'Error'); return; }
      loadUsers();
      toast(`User "${username}" deleted.`, 'info');
    },
  });
}

// ── System configuration ──────────────────────────────────────────────────────
async function downloadBackup(btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const res = await fetch('/api/config/backup');
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('Server error ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `verdix-license-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded successfully.', 'success', 'Backup Complete');
  } catch (ex) {
    toast('Backup failed: ' + ex.message, 'error', 'Backup Failed');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

async function doRestore(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  _pendingRestoreFile = file;
  $('restore-msg').style.display = 'none';
  openConfirm({
    title: 'Restore from Backup',
    subtitle: `File: ${file.name}`,
    message: '<strong style="color:#fcd34d">All existing customers, licenses, and activations will be replaced.</strong> Admin accounts are kept. This cannot be undone.',
    danger: true,
    confirmLabel: 'Restore',
    onConfirm: doRestoreConfirmed,
  });
}
async function doRestoreConfirmed() {
  const file = _pendingRestoreFile;
  _pendingRestoreFile = null;
  if (!file) return;
  const msg = $('restore-msg');
  msg.textContent = 'Uploading and restoring…';
  msg.style.cssText = 'display:block;margin-top:14px;padding:11px 13px;border-radius:10px;font-size:13px;color:var(--muted2);background:var(--panel2);border:1px solid var(--border2)';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await api('/api/config/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.success) throw new Error(res.error);
    const d = res.data;
    msg.textContent = `✓ Restored: ${d.customers} customers, ${d.licenses} licenses, ${d.activations} activations.`;
    msg.style.cssText = 'display:block;margin-top:14px;padding:11px 13px;border-radius:10px;font-size:13px;color:#86efac;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.35)';
    toast(`Restored ${d.customers} customers, ${d.licenses} licenses, ${d.activations} activations.`, 'success', 'Restore Complete');
  } catch (ex) {
    msg.textContent = 'Restore failed: ' + ex.message;
    msg.style.cssText = 'display:block;margin-top:14px;padding:11px 13px;border-radius:10px;font-size:13px;color:#fca5a5;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35)';
    toast('Restore failed: ' + ex.message, 'error', 'Restore Failed');
  }
}

function resetData() {
  $('reset-confirm-input').value = '';
  $('reset-confirm-btn').disabled = true;
  $('reset-err').className = 'err';
  $('reset-err').textContent = '';
  show('reset-modal');
  setTimeout(() => $('reset-confirm-input').focus(), 320);
}
async function confirmReset() {
  const btn = $('reset-confirm-btn');
  const err = $('reset-err');
  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    const res = await api('/api/config/reset', { method: 'POST' });
    if (!res.success) throw new Error(res.error);
    closeModal('reset-modal');
    loadStats();
    toast('All data has been reset successfully.', 'info', 'Data Reset');
  } catch (ex) {
    err.textContent = ex.message;
    err.className = 'err show';
    btn.disabled = false;
    btn.textContent = 'Reset All Data';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function logout() { await api('/api/logout', { method: 'POST' }); location.href = '/login'; }
(async function init() {
  try {
    const me = await api('/api/me');
    if (me.success) {
      $('who').textContent = me.data.username;
      const av = $('user-av');
      if (av) av.textContent = (me.data.username || 'A').charAt(0).toUpperCase();
      currentRole = me.data.role;
      if (me.data.role !== 'admin') {
        const navUsers = $('nav-users'); if (navUsers) navUsers.style.display = 'none';
        const navConfig = $('nav-config'); if (navConfig) navConfig.style.display = 'none';
      }
      const cloudBtn = $('btn-cloud-customer');
      if (cloudBtn) cloudBtn.style.display = currentRole === 'admin' ? '' : 'none';
    }
  } catch {}
  loadStats();
})();
