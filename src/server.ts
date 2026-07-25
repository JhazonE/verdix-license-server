/**
 * License Management System — HTTP server.
 * ----------------------------------------------------------------------------
 * Serves the admin dashboard + JSON APIs for managing customers, licenses and
 * activations, and issuing machine-bound signed license keys.
 *
 * Run from the repo root:  npm run license:server
 * Default: http://localhost:4100   (override with LICENSE_UI_PORT)
 *
 * NOTE: Online POS activation endpoints (Phase 2) will be added to this same
 * server later. This build covers the management dashboard (Phases 1 & 3).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { migrate } from './schema';
import { initCache } from './cache';
import {
  getAdminByUsername,
  verifyPassword,
  createSession,
  verifySession,
  touchLogin,
  anyAdminExists,
  createAdmin,
  listAdmins,
  deleteAdmin,
  updateAdminPassword,
  countAdmins,
  getAdminById,
  updateAdmin,
  SessionPayload,
} from './auth';
import * as svc from './service';
import { listProducts, createProduct, getProduct, setProductEmbedMark } from './products';
import { hasPrivateKey, getPrivateKeySource, getKeyFileHint } from './keys';
import { publicKeyFingerprint, deriveEmbedState, deriveSetupPill } from './setup-status';

dotenv.config();

// Railway injects PORT; LICENSE_UI_PORT is the local dev override.
const PORT = parseInt(process.env.PORT || process.env.LICENSE_UI_PORT || '4100', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Small HTTP helpers ───────────────────────────────────────────────────────
type Req = http.IncomingMessage;
type Res = http.ServerResponse;

function sendJson(res: Res, status: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res: Res, file: string, type: string) {
  try {
    const content = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req: Req): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function parseCookies(req: Req): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res: Res, token: string) {
  const parts = [
    `lms_session=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Res) {
  res.setHeader('Set-Cookie', 'lms_session=; HttpOnly; Path=/; Max-Age=0');
}

function getSession(req: Req): SessionPayload | null {
  return verifySession(parseCookies(req).lms_session);
}

function clientIp(req: Req): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    ''
  );
}

/**
 * Decode a path segment, treating a malformed escape as "no such id" rather
 * than letting URIError surface as a 500. url.pathname is not pre-decoded, so
 * a stray '%' in the URL reaches decodeURIComponent verbatim.
 */
function decodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

async function cloudConfigFor(license: { id: string; features: string[] | null }) {
  if (!license.features || !license.features.includes('cloud-sync')) return undefined;
  try {
    const cfg = await svc.getCloudConfig(license.id);
    return cfg || undefined;
  } catch (e) {
    console.error('[license] cloudConfig lookup failed (check CLOUD_CONFIG_SECRET):', (e as Error).message);
    return undefined;
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
async function handle(req: Req, res: Res) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  // --- Static / pages ---
  if (method === 'GET' && (p === '/login' || p === '/login.html')) {
    return sendFile(res, 'login.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && (p === '/' || p === '/index.html' || p === '/dashboard')) {
    if (!getSession(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    return sendFile(res, 'dashboard.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && p === '/app.js') {
    return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
  }

  // --- Auth APIs ---
  if (method === 'POST' && p === '/api/login') {
    const { username, password } = await readBody(req);
    const user = await getAdminByUsername(String(username || ''));
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
      return sendJson(res, 401, { success: false, error: 'Invalid username or password.' });
    }
    await touchLogin(user.id);
    setSessionCookie(res, createSession(user));
    return sendJson(res, 200, { success: true, user: { username: user.username, role: user.role } });
  }
  if (method === 'POST' && p === '/api/logout') {
    clearSessionCookie(res);
    return sendJson(res, 200, { success: true });
  }

  // --- PUBLIC: POS online activation (no admin auth) ---
  // The POS calls this with a Product Key + its Machine ID; we validate, enforce
  // seats/expiry/status, sign a machine-bound license, record the activation,
  // and return the signed key.
  if (method === 'POST' && p === '/api/activate') {
    const ip = clientIp(req);
    try {
      const body = await readBody(req);
      const productKey = String(body.productKey || '').trim();
      const machineId = String(body.machineId || '').trim();
      if (!productKey || !machineId)
        return sendJson(res, 400, { success: false, error: 'Product key and Machine ID are required.' });

      const license = await svc.getLicenseByProductKey(productKey);
      if (!license) {
        await svc.log(null, machineId, 'activate.fail', 'Unknown product key ' + productKey, ip);
        return sendJson(res, 404, { success: false, error: 'Invalid product key. Please check and try again.' });
      }
      if (license.status !== 'active') {
        await svc.log(license.id, machineId, 'activate.fail', 'License ' + license.status, ip);
        return sendJson(res, 403, { success: false, error: `This license has been ${license.status}. Contact your vendor.` });
      }
      if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) {
        await svc.log(license.id, machineId, 'activate.fail', 'Expired', ip);
        return sendJson(res, 403, { success: false, error: 'This license has expired. Please renew.' });
      }

      // Seat enforcement (a machine that's already activated can re-fetch freely).
      const already = await svc.machineAlreadyActivated(license.id, machineId);
      if (!already) {
        const used = await svc.countActiveActivations(license.id);
        if (used >= license.max_activations)
          return sendJson(res, 403, {
            success: false,
            error: `Activation limit reached (${used}/${license.max_activations}). Contact your vendor to add seats or release one.`,
          });
      }

      const { signedLicense, payload } = await svc.issueSignedLicense(license, machineId, {
        machineLabel: body.machineLabel,
        appVersion: body.appVersion,
        ip,
      });
      await svc.log(license.id, payload.machineId, 'activate.online', 'Online activation', ip);

      const cloudConfig = await cloudConfigFor(license);
      return sendJson(res, 200, {
        success: true,
        signedLicense,
        info: { customer: payload.customer, edition: payload.edition, expires: payload.expires },
        ...(cloudConfig ? { cloudConfig } : {}),
      });
    } catch (e: any) {
      console.error('Activation error:', e);
      return sendJson(res, 500, { success: false, error: 'Activation failed on the server.' });
    }
  }

  // --- PUBLIC: POS heartbeat / revocation check (no admin auth) ---
  // An activated POS periodically calls this with its license id + machine id.
  // We return the current status (so revocation/suspension is enforced) and,
  // when still active, a freshly-signed license so renewals propagate.
  if (method === 'POST' && p === '/api/validate') {
    try {
      const body = await readBody(req);
      const licenseId = String(body.licenseId || '').trim();
      const machineId = String(body.machineId || '').trim();
      if (!licenseId || !machineId)
        return sendJson(res, 400, { success: false, error: 'licenseId and machineId are required.' });

      const result = await svc.validateHeartbeat(licenseId, machineId, {
        appVersion: body.appVersion,
        ip: clientIp(req),
      });
      const license = await svc.getLicense(licenseId);
      const cloudConfig =
        result.status === 'active' && license ? await cloudConfigFor(license) : undefined;
      return sendJson(res, 200, { success: true, ...result, ...(cloudConfig ? { cloudConfig } : {}) });
    } catch (e: any) {
      console.error('Validate error:', e);
      return sendJson(res, 500, { success: false, error: 'Validation failed on the server.' });
    }
  }

  // --- Everything below requires a valid session ---
  const session = getSession(req);
  if (p.startsWith('/api/')) {
    if (!session) return sendJson(res, 401, { success: false, error: 'Not authenticated.' });

    try {
      // GET /api/me
      if (method === 'GET' && p === '/api/me') {
        return sendJson(res, 200, { success: true, data: { username: session.username, role: session.role } });
      }

      // GET /api/stats
      if (method === 'GET' && p === '/api/stats') {
        return sendJson(res, 200, { success: true, data: await svc.dashboardStats() });
      }

      // Customers
      if (method === 'GET' && p === '/api/customers') {
        return sendJson(res, 200, { success: true, data: await svc.listCustomers() });
      }
      if (method === 'POST' && p === '/api/customers') {
        const body = await readBody(req);
        if (!body.business_name?.trim())
          return sendJson(res, 400, { success: false, error: 'Business name is required.' });
        return sendJson(res, 200, { success: true, data: await svc.createCustomer(body) });
      }

      // Products
      if (method === 'GET' && p === '/api/products') {
        return sendJson(res, 200, { success: true, data: await listProducts() });
      }
      if (method === 'POST' && p === '/api/products') {
        const body = await readBody(req);
        try {
          const created = await createProduct(body);
          return sendJson(res, 200, { success: true, data: created });
        } catch (e) {
          return sendJson(res, 400, { success: false, error: (e as Error).message });
        }
      }

      // GET /api/products/:id/setup — derived setup checklist state.
      // Returns the PUBLIC key (developers need it to embed) and only a label
      // for the private key. No private key material is ever serialized.
      const setupMatch = p.match(/^\/api\/products\/([^/]+)\/setup$/);
      if (method === 'GET' && setupMatch) {
        const id = decodeSegment(setupMatch[1]);
        if (!id) return sendJson(res, 404, { success: false, error: 'Product not found.' });
        const product = await getProduct(id);
        if (!product) return sendJson(res, 404, { success: false, error: 'Product not found.' });

        const source = getPrivateKeySource(product);
        const embed = deriveEmbedState(product.public_key, product.embed_marked);
        const hasKeypair = !!product.public_key;

        return sendJson(res, 200, {
          success: true,
          data: {
            productId: product.id,
            licensePrefix: product.license_prefix,
            keyPrefix: product.key_prefix,
            envKeyName: product.env_key_name,
            publicKey: product.public_key,
            // Resolved server-side: verdix-pos uses the flat keys/private-key.pem,
            // so the dashboard must not derive keys/<id>/private-key.pem itself.
            keyFile: getKeyFileHint(product),
            pill: deriveSetupPill({ hasKeypair, source, embed }),
            steps: {
              registered: { ok: true },
              keypair: { ok: hasKeypair },
              embed: {
                state: embed,
                at: product.embed_marked?.at ?? null,
                by: product.embed_marked?.by ?? null,
              },
              signing: { ok: source !== 'none', source },
            },
          },
        });
      }

      // POST /api/products/:id/embed — record or clear the operator's assertion
      // that the public key was embedded in the product's app.
      const embedMatch = p.match(/^\/api\/products\/([^/]+)\/embed$/);
      if (method === 'POST' && embedMatch) {
        const id = decodeSegment(embedMatch[1]);
        if (!id) return sendJson(res, 404, { success: false, error: 'Product not found.' });
        const product = await getProduct(id);
        if (!product) return sendJson(res, 404, { success: false, error: 'Product not found.' });

        const body = await readBody(req);
        if (body.marked === false) {
          await setProductEmbedMark(product.id, null);
          return sendJson(res, 200, { success: true });
        }

        if (!product.public_key) {
          return sendJson(res, 400, {
            success: false,
            error: 'No public key yet — run keygen for this product first.',
          });
        }

        // key_fp is computed HERE from the stored key, and `by` comes from the
        // session. Accepting either from the request body would let any
        // fingerprint be marked, defeating stale detection entirely.
        await setProductEmbedMark(product.id, {
          at: new Date().toISOString(),
          by: session.username,
          key_fp: publicKeyFingerprint(product.public_key),
        });
        return sendJson(res, 200, { success: true });
      }

      // Licenses
      if (method === 'GET' && p === '/api/licenses') {
        return sendJson(res, 200, { success: true, data: await svc.listLicenses() });
      }
      if (method === 'POST' && p === '/api/licenses') {
        const body = await readBody(req);
        if (!body.customer_id) return sendJson(res, 400, { success: false, error: 'customer_id required.' });
        const lic = await svc.createLicense({
          ...body,
          product_id: body.product_id,
          created_by: session.username,
        });
        return sendJson(res, 200, { success: true, data: lic });
      }

      // /api/licenses/:id/(status|sign)
      const licMatch = p.match(/^\/api\/licenses\/([^/]+)\/(status|sign)$/);
      if (method === 'POST' && licMatch) {
        const [, id, action] = licMatch;
        const license = await svc.getLicense(id);
        if (!license) return sendJson(res, 404, { success: false, error: 'License not found.' });
        const body = await readBody(req);

        if (action === 'status') {
          const status = body.status;
          if (!['active', 'suspended', 'revoked'].includes(status))
            return sendJson(res, 400, { success: false, error: 'Invalid status.' });
          await svc.setLicenseStatus(id, status);
          return sendJson(res, 200, { success: true });
        }

        if (action === 'sign') {
          if (license.status !== 'active')
            return sendJson(res, 400, { success: false, error: `License is ${license.status}.` });
          if (!body.machineId?.trim())
            return sendJson(res, 400, { success: false, error: 'Machine ID is required.' });

          // Enforce seat limit for NEW machines.
          const already = await svc.machineAlreadyActivated(id, body.machineId);
          if (!already) {
            const used = await svc.countActiveActivations(id);
            if (used >= license.max_activations)
              return sendJson(res, 400, {
                success: false,
                error: `Activation limit reached (${used}/${license.max_activations}). Release a seat first.`,
              });
          }

          const { signedLicense, payload } = await svc.issueSignedLicense(license, body.machineId, {
            machineLabel: body.machineLabel,
            ip: clientIp(req),
          });
          return sendJson(res, 200, { success: true, data: { signedLicense, payload } });
        }
      }

      // Activations
      if (method === 'GET' && p === '/api/activations') {
        const licenseId = url.searchParams.get('licenseId') || undefined;
        return sendJson(res, 200, { success: true, data: await svc.listActivations(licenseId) });
      }
      const relMatch = p.match(/^\/api\/activations\/([^/]+)\/release$/);
      if (method === 'POST' && relMatch) {
        await svc.releaseActivation(relMatch[1]);
        return sendJson(res, 200, { success: true });
      }

      // Admin user management (administrators only)
      if (p.startsWith('/api/users')) {
        if (session.role !== 'admin')
          return sendJson(res, 403, { success: false, error: 'Only administrators can manage users.' });

        if (method === 'GET' && p === '/api/users') {
          return sendJson(res, 200, { success: true, data: await listAdmins() });
        }
        if (method === 'POST' && p === '/api/users') {
          const body = await readBody(req);
          const username = String(body.username || '').trim().toLowerCase();
          const password = String(body.password || '');
          const role = ['admin', 'manager', 'staff'].includes(body.role) ? body.role : 'admin';
          if (!username || password.length < 6)
            return sendJson(res, 400, { success: false, error: 'Username and a password (min 6 characters) are required.' });
          if (await getAdminByUsername(username))
            return sendJson(res, 400, { success: false, error: 'That username already exists.' });
          await createAdmin(username, password, role);
          return sendJson(res, 200, { success: true });
        }
        // Update username/role (and optional password) of an existing user.
        const updMatch = p.match(/^\/api\/users\/([^/]+)$/);
        if (method === 'POST' && updMatch) {
          const id = updMatch[1];
          const target = await getAdminById(id);
          if (!target) return sendJson(res, 404, { success: false, error: 'User not found.' });

          const body = await readBody(req);
          const username = String(body.username || '').trim().toLowerCase();
          const role = ['admin', 'manager', 'staff'].includes(body.role) ? body.role : target.role;
          if (!username) return sendJson(res, 400, { success: false, error: 'Username is required.' });

          if (username !== target.username && (await getAdminByUsername(username)))
            return sendJson(res, 400, { success: false, error: 'That username already exists.' });

          // Never let the last administrator lose admin rights (lock-out guard).
          if (target.role === 'admin' && role !== 'admin') {
            const admins = (await listAdmins()).filter((u) => u.role === 'admin');
            if (admins.length <= 1)
              return sendJson(res, 400, { success: false, error: 'Cannot remove the last administrator.' });
          }

          if (body.password) {
            if (String(body.password).length < 6)
              return sendJson(res, 400, { success: false, error: 'Password must be at least 6 characters.' });
            await updateAdminPassword(id, body.password);
          }
          await updateAdmin(id, { username, role });
          return sendJson(res, 200, { success: true });
        }
        const um = p.match(/^\/api\/users\/([^/]+)\/(password|delete)$/);
        if (method === 'POST' && um) {
          const [, id, action] = um;
          if (action === 'password') {
            const body = await readBody(req);
            if (String(body.password || '').length < 6)
              return sendJson(res, 400, { success: false, error: 'Password must be at least 6 characters.' });
            await updateAdminPassword(id, body.password);
            return sendJson(res, 200, { success: true });
          }
          if (action === 'delete') {
            if (id === session.uid)
              return sendJson(res, 400, { success: false, error: 'You cannot delete your own account.' });
            if ((await countAdmins()) <= 1)
              return sendJson(res, 400, { success: false, error: 'Cannot delete the last administrator.' });
            await deleteAdmin(id);
            return sendJson(res, 200, { success: true });
          }
        }
      }

      // System configuration (admin only)
      if (p.startsWith('/api/config')) {
        if (session.role !== 'admin')
          return sendJson(res, 403, { success: false, error: 'Only administrators can access system configuration.' });

        if (method === 'GET' && p === '/api/config/backup') {
          const backup = await svc.exportBackup();
          const json = JSON.stringify(backup, null, 2);
          const filename = `verdix-license-backup-${new Date().toISOString().slice(0, 10)}.json`;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          });
          return res.end(json);
        }

        if (method === 'POST' && p === '/api/config/reset') {
          await svc.resetAllData();
          await svc.log(null, null, 'system.reset', `All data reset by ${session.username}`);
          return sendJson(res, 200, { success: true });
        }

        if (method === 'POST' && p === '/api/config/restore') {
          const body = await readBody(req);
          const result = await svc.importBackup(body);
          await svc.log(null, null, 'system.restore',
            `Backup restored by ${session.username}: ${result.customers} customers, ${result.licenses} licenses, ${result.activations} activations`);
          return sendJson(res, 200, { success: true, data: result });
        }
      }

      return sendJson(res, 404, { success: false, error: 'Unknown endpoint.' });
    } catch (e: any) {
      console.error('API error:', e);
      return sendJson(res, 500, { success: false, error: e?.message || 'Server error.' });
    }
  }

  res.writeHead(404);
  res.end('Not found');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  console.log('\n🔧 Preparing License Server…');
  try {
    await migrate();
  } catch (e: any) {
    console.error('❌ Database not ready:', e.message);
    console.error('   Check your LICENSE_DB_* / CLOUD_DB_* settings in .env\n');
    process.exit(1);
  }

  await initCache();

  if (!hasPrivateKey()) {
    console.warn('⚠️  No signing key found. Run `npm run license:keygen` (signing will fail).');
  }
  if (!(await anyAdminExists())) {
    console.warn('⚠️  No admin user yet. Run `npm run license:seed-admin` to create one.');
  }

  http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('Unhandled:', e);
      try {
        res.writeHead(500);
        res.end('Server error');
      } catch {
        /* noop */
      }
    });
  }).listen(PORT, () => {
    console.log('\n🔑 Vendix License Management System');
    console.log('   ▶ http://localhost:' + PORT + '\n');
  });
}

boot();
