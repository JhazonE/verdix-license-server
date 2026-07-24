/* Vendix LMS dashboard logic (vanilla JS). */

let customersCache = [];
let licensesCache = [];
let activationsCache = [];
let usersCache = [];
let signLicenseId = null;
let editUserId = null;
let pwResetUserId = null;
let _pendingRestoreFile = null;
let _confirmCallback = null;

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
  licenses:    ['Licenses',             'Issue and manage product keys'],
  activations: ['Activations',          'Machines currently using your licenses'],
  users:       ['Team',                 'Administrators who can access this dashboard'],
  config:      ['System Configuration', 'Backup, restore, and reset license data'],
};
const ALL_TABS = ['overview', 'customers', 'licenses', 'activations', 'users', 'config'];
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

// ── Licenses ──────────────────────────────────────────────────────────────────
async function loadLicenses() {
  $('licenses-table').innerHTML = skeletonTable(8);
  const { data } = await api('/api/licenses');
  licensesCache = data;
  renderLicenses();
}
function renderLicenses() {
  const el = $('licenses-table');
  if (!licensesCache.length) { setCount('licenses-count', 0, 0); el.innerHTML = '<div class="empty">No licenses yet. Click "Issue License".</div>'; return; }
  const q = val('licenses-search');
  const data = licensesCache.filter((l) => matchesQuery(l, ['product_key', 'business_name', 'edition', 'status', 'type'], q));
  setCount('licenses-count', data.length, licensesCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No licenses match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Product Key</th><th>Customer</th><th>Edition</th><th>Type</th><th>Expires</th><th>Computers</th><th>Status</th><th></th></tr></thead><tbody>${
    data.map((l) => `<tr>
      <td><code class="key">${esc(l.product_key)}</code></td>
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
  $('l-edition').value = 'standard'; $('l-type').value = 'perpetual'; $('l-days').value = ''; $('l-expires').value = '';
  $('l-seats').value = '1'; $('l-features').value = ''; $('l-notes').value = '';
  $('l-err').classList.remove('show');
  toggleExpiry();
  show('license-modal');
}
async function saveLicense() {
  const type = val('l-type');
  const body = {
    customer_id: val('l-customer'), edition: val('l-edition'), type,
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
      if (me.data.role !== 'admin') {
        const navUsers = $('nav-users'); if (navUsers) navUsers.style.display = 'none';
        const navConfig = $('nav-config'); if (navConfig) navConfig.style.display = 'none';
      }
    }
  } catch {}
  loadStats();
})();
