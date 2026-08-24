import http from 'http';
import crypto from 'crypto';
import { sendWebhook, computeSignature } from '../src/webhooks';

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let failures = 0;
  function check(name: string, cond: boolean) {
    if (cond) {
      console.log('  ok   ' + name);
    } else {
      console.error('  FAIL ' + name);
      failures++;
    }
  }

  const secret = 'test-secret-abc123';

  // 1. computeSignature is a stable, verifiable HMAC-SHA256 of the raw body.
  {
    const body = '{"a":1}';
    const sig = computeSignature(secret, body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    check('computeSignature matches manual HMAC', sig === expected);
  }

  // 2. Successful single delivery: correct headers, correct body, correct signature.
  {
    let received: { headers: http.IncomingHttpHeaders; body: string } | null = null;
    const mock = await startMockServer((req, res, body) => {
      received = { headers: req.headers, body };
      res.writeHead(200);
      res.end('ok');
    });
    sendWebhook({ id: 'p1', webhook_url: mock.url, webhook_secret: secret }, 'license.activated', { licenseId: 'L1' });
    await sleep(300);
    await mock.close();

    check('request reached the mock server', received !== null);
    if (received) {
      const r: { headers: http.IncomingHttpHeaders; body: string } = received;
      check('X-Webhook-Event header set', r.headers['x-webhook-event'] === 'license.activated');
      const sigHeader = r.headers['x-webhook-signature'] as string;
      check('X-Webhook-Signature matches body', sigHeader === computeSignature(secret, r.body));
      const parsed = JSON.parse(r.body);
      check('body has event/productId/data', parsed.event === 'license.activated' && parsed.productId === 'p1' && parsed.data.licenseId === 'L1');
    }
  }

  // 3. Retry: first two attempts 500, third succeeds.
  {
    let attempts = 0;
    const mock = await startMockServer((req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(500);
        res.end('fail');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    sendWebhook({ id: 'p2', webhook_url: mock.url, webhook_secret: secret }, 'license.issued', { a: 1 });
    await sleep(8000); // 1s + 5s backoff plus request time
    await mock.close();
    check('retried until success (3 attempts)', attempts === 3);
  }

  // 4. Exhaustion: always fails, gives up after 3 attempts, never throws.
  {
    let attempts = 0;
    const mock = await startMockServer((req, res) => {
      attempts++;
      res.writeHead(500);
      res.end('fail');
    });
    let threw = false;
    try {
      sendWebhook({ id: 'p3', webhook_url: mock.url, webhook_secret: secret }, 'license.revoked', { a: 1 });
    } catch {
      threw = true;
    }
    await sleep(8000);
    await mock.close();
    check('sendWebhook call itself never throws', !threw);
    check('gave up after exactly 3 attempts', attempts === 3);
  }

  // 5. No-op when webhook_url is null — must not throw, must not hang.
  {
    let threw = false;
    try {
      sendWebhook({ id: 'p4', webhook_url: null, webhook_secret: null }, 'customer.created', {});
    } catch {
      threw = true;
    }
    check('no-op with null webhook_url does not throw', !threw);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: webhook signing, delivery, retry and no-op behavior are correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
