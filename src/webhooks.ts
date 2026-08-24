/**
 * Outbound license-event webhooks. Delivery is fire-and-forget: callers never
 * await this and it never throws or rejects in a way a caller could observe —
 * a webhook failure must never break the license operation that triggered it.
 */
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { log } from './service';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000]; // delay before attempt 2 and attempt 3
const REQUEST_TIMEOUT_MS = 5000;

export function computeSignature(secret: string, rawBody: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postOnce(url: string, rawBody: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(rawBody) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // drain, we don't care about the response body
        resolve(res.statusCode || 0);
      }
    );
    req.on('timeout', () => req.destroy(new Error('webhook request timed out')));
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

async function deliverWithRetry(
  productId: string,
  url: string,
  event: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
    try {
      const status = await postOnce(url, rawBody, headers);
      if (status >= 200 && status < 300) return;
      lastError = `HTTP ${status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  const host = safeHost(url);
  await log(null, null, 'webhook.fail', `product=${productId} event=${event} url_host=${host} error=${lastError}`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable-url';
  }
}

export interface WebhookableProduct {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
}

/**
 * Fire a webhook for a license/customer event. No-op if the product has no
 * webhook_url configured. Never throws; delivery (including retry) happens
 * in the background after this function returns.
 */
export function sendWebhook(product: WebhookableProduct, event: string, data: object): void {
  try {
    if (!product.webhook_url || !product.webhook_secret) return;

    const rawBody = JSON.stringify({
      event,
      productId: product.id,
      timestamp: new Date().toISOString(),
      data,
    });
    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': event,
      'X-Webhook-Signature': computeSignature(product.webhook_secret, rawBody),
    };

    deliverWithRetry(product.id, product.webhook_url, event, rawBody, headers).catch(() => {
      // deliverWithRetry already logs failures internally; this catch exists
      // only to guarantee nothing here can produce an unhandled rejection.
    });
  } catch {
    // Building the request (e.g. JSON.stringify on circular/unsupported data)
    // must never throw out into the caller — a webhook failure must never
    // break the license operation that triggered it.
  }
}
