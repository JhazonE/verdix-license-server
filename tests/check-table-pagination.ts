/**
 * Verifies the dashboard's table sorting and pagination.
 *
 * public/app.js is browser code with no module system, so this loads it into a
 * vm context with a DOM small enough to run the renderers, then renders each of
 * the five data tables against fake caches and checks the markup. No server and
 * no database needed.
 *
 * Run with: npx tsx tests/check-table-pagination.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const APP_JS = join(__dirname, '..', 'public', 'app.js');
const src = readFileSync(APP_JS, 'utf8');

// ── A DOM just big enough for the renderers ──────────────────────────────────
type El = { id: string; innerHTML: string; textContent: string; value?: string; classList: Record<string, unknown> };

const store: Record<string, El> = {};
const mkEl = (id: string): El => ({
  id,
  innerHTML: '',
  textContent: '',
  value: '',
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
});

for (const id of [
  // app.js runs init() on load, which touches these before any table renders.
  'stats', 'page-title', 'page-sub',
  'customers-table', 'customers-count', 'customers-search',
  'products-table', 'products-count', 'products-search',
  'licenses-table', 'licenses-count', 'licenses-search', 'licenses-product-filter',
  'activations-table', 'activations-count', 'activations-search',
  'users-table', 'users-count', 'users-search',
]) store[id] = mkEl(id);

const sandbox: Record<string, unknown> = {
  console,
  document: { getElementById: (id: string) => store[id] || null, querySelectorAll: () => [], addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
  unescape, encodeURIComponent, decodeURIComponent,
  location: { href: '', reload() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const run = (code: string) => vm.runInContext(code, sandbox);
const htmlOf = (el: string) => store[el].innerHTML;
const bodyOf = (html: string) => html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
const rowCount = (html: string) => (bodyOf(html).match(/<tr(?: |>)/g) || []).length;

// ── Fake caches: 37 rows, so 4 pages at the default 10 per page ──────────────
const N = 37;
const pad = (i: number) => String(i).padStart(3, '0');

run('customersCache = ' + JSON.stringify(Array.from({ length: N }, (_, i) => ({
  id: i, business_name: 'Biz ' + pad(i), contact_name: 'C' + i, email: `e${i}@x.com`,
  phone: '09' + i, license_count: i % 7, created_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
}))));
run('productsCache = ' + JSON.stringify(Array.from({ length: N }, (_, i) => ({
  id: 'p-' + pad(i), name: 'Prod ' + pad(i), key_prefix: 'PK' + i, license_prefix: 'LP' + i,
  env_key_name: 'ENV_' + i, public_key: i % 2 ? 'k' : null, status: 'active',
}))));
run('licensesCache = ' + JSON.stringify(Array.from({ length: N }, (_, i) => ({
  id: 'l' + i, product_key: 'KEY-' + pad(i), product_id: 'p-' + pad(i % 3), business_name: 'Biz ' + pad(i),
  edition: 'Std', type: i % 2 ? 'subscription' : 'perpetual', expires_at: '2027-01-01',
  active_count: i % 5, max_activations: 5, status: 'active', features: [],
}))));
run('activationsCache = ' + JSON.stringify(Array.from({ length: N }, (_, i) => ({
  id: 'a' + i, business_name: 'Biz ' + pad(i), product_key: 'KEY-' + pad(i), machine_id: 'machine-id-long-' + i,
  machine_label: 'L' + i, status: 'active', last_seen_at: '2026-10-01', activated_at: '2026-09-01',
}))));
run('usersCache = ' + JSON.stringify(Array.from({ length: N }, (_, i) => ({
  id: 'u' + i, username: 'user' + pad(i), role: 'admin', created_at: '2026-01-01',
  last_login_at: i % 2 ? '2026-10-01' : null,
}))));

// ── Every table gets a sortable header row and a pager ───────────────────────
const tables = [
  { name: 'customers', render: 'renderCustomers', el: 'customers-table', cols: 6, rowsPerPage: 10 },
  // Products renders two <tr>s per product (the row and its setup detail), so
  // the page is sliced over products, not over table rows.
  { name: 'products', render: 'renderProducts', el: 'products-table', cols: 8, rowsPerPage: 20 },
  { name: 'licenses', render: 'renderLicenses', el: 'licenses-table', cols: 9, rowsPerPage: 10 },
  { name: 'activations', render: 'renderActivations', el: 'activations-table', cols: 8, rowsPerPage: 10 },
  { name: 'users', render: 'renderUsers', el: 'users-table', cols: 5, rowsPerPage: 10 },
];

for (const t of tables) {
  run(t.render + '();');
  const html = htmlOf(t.el);
  const head = html.slice(0, html.indexOf('</thead>'));

  assert.ok(html.includes('<table>'), `${t.name}: renders a table`);
  assert.equal(html.indexOf('<div class="table-scroll">'), 0, `${t.name}: table sits in a scroll box`);
  assert.ok(html.includes('class="pager"'), `${t.name}: has a pager`);
  assert.ok(html.indexOf('class="pager"') > html.indexOf('</table>'), `${t.name}: pager follows the table`);
  assert.equal((head.match(/<th\b/g) || []).length, t.cols, `${t.name}: ${t.cols} header cells`);
  assert.equal(rowCount(html), t.rowsPerPage, `${t.name}: 10 rows on page 1`);
  assert.ok(html.includes('Page 1 of 4'), `${t.name}: 37 rows / 10 per page = 4 pages`);
  assert.ok(html.includes('Showing 1–10 of 37'), `${t.name}: states the range`);
  assert.ok(html.includes('max 10 per page'), `${t.name}: states the max rows per page`);
  assert.ok(html.includes(`'${t.render}'`), `${t.name}: headers call its own renderer`);
  assert.ok(html.includes('aria-sort="none"'), `${t.name}: unsorted headers carry aria-sort`);
  assert.ok(html.includes('<button type="button" class="th-sort"'), `${t.name}: headers are real buttons`);
}

// ── Paging moves through the rows ────────────────────────────────────────────
run("setPage('customers', 4, 'renderCustomers');");
let html = htmlOf('customers-table');
assert.equal(rowCount(html), 7, 'last page holds the remaining 7 of 37');
assert.ok(html.includes('Showing 31–37 of 37'), 'last page states its range');
assert.ok(html.includes('Biz 036'), 'last page holds the final row');

// A page number past the end falls back to the last page with rows.
run("setPage('customers', 99, 'renderCustomers');");
assert.ok(htmlOf('customers-table').includes('Page 4 of 4'), 'a page past the end clamps to the last');

// ── Sorting reorders, and cycles asc -> desc -> cleared ─────────────────────
run("setPage('customers', 1, 'renderCustomers'); sortBy('customers','business_name','renderCustomers');");
html = htmlOf('customers-table');
assert.ok(html.indexOf('Biz 000') < html.indexOf('Biz 001'), 'ascending orders A->Z');
assert.ok(html.includes('aria-sort="ascending"'), 'ascending marks the header');

run("sortBy('customers','business_name','renderCustomers');");
html = htmlOf('customers-table');
assert.ok(html.includes('Biz 036'), 'descending brings the last row to page 1');
assert.ok(html.includes('aria-sort="descending"'), 'descending marks the header');

run("sortBy('customers','business_name','renderCustomers');");
assert.ok(!htmlOf('customers-table').includes('aria-sort="ascending"'), 'a third click clears the sort');
assert.ok(!htmlOf('customers-table').includes('aria-sort="descending"'), 'a third click clears the arrow');

// Sorting from a later page returns to page 1.
run("setPage('customers', 3, 'renderCustomers'); sortBy('customers','email','renderCustomers');");
assert.ok(htmlOf('customers-table').includes('Page 1 of 4'), 'sorting resets to page 1');

// ── Products: the page slices products, keeping each detail row with its row ─
run("setPerPage('products','10','renderProducts');");
html = htmlOf('products-table');
assert.equal((html.match(/class="expandable"/g) || []).length, 10, 'products: 10 products on a page');
assert.equal((html.match(/class="detail/g) || []).length, 10, 'products: one detail row per product');
assert.ok(html.includes('colspan="8"'), 'products: the detail row still spans every column');

// ── Searching and filtering reset the page ───────────────────────────────────
run("setPage('customers', 3, 'renderCustomers'); resetPage('customers','renderCustomers');");
assert.ok(htmlOf('customers-table').includes('Page 1 of 4'), 'resetPage returns to page 1');

// ── No match keeps the existing empty message, with no pager ─────────────────
store['customers-search'].value = 'zzz-no-such-row';
run('renderCustomers();');
html = htmlOf('customers-table');
assert.ok(html.includes('No customers match your search.'), 'no match keeps the empty message');
assert.ok(!html.includes('class="pager"'), 'no match renders no pager');
store['customers-search'].value = '';

// ── Rows per page: All puts everything on one page ───────────────────────────
run("setPerPage('customers','all','renderCustomers');");
html = htmlOf('customers-table');
assert.equal(rowCount(html), N, 'All shows every row');
assert.ok(html.includes('Page 1 of 1'), 'All is a single page');
assert.ok(!html.includes('max '), 'All drops the max-per-page note');
run("setPerPage('customers','10','renderCustomers');");

// ── The skeleton loader stays a bare table, so it keeps its own borders ──────
const skel = run('skeletonTable(6)') as string;
assert.equal(skel.indexOf('<table>'), 0, 'the skeleton is still the card’s direct child');
assert.ok(!skel.includes('pager'), 'the skeleton has no pager');

console.log('All table sorting and pagination checks passed.');
