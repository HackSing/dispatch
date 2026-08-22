/**
 * `/api/dispatch/*` routes on the dsh web server. Two endpoints:
 *   POST /api/dispatch/invoke/<channel>  — body is InvokeMap req, response {ok,value} | {ok,error}
 *   GET  /api/dispatch/events            — SSE stream, one named event per EventMap channel
 *
 * SECURITY: loopback only (照抄 docs-harness routes.js 的两道门之一 — the
 * second gate, resolving paths from the request body, lives in core stores).
 *
 * @module dsh-dispatch/host/routes
 */
import { MAX_BODY_BYTES, INVOKE_PATH_PREFIX, ROUTE_PREFIX } from './constants.js';

/**
 * @param {object} ctx - host context carrying `webServer`.
 * @param {{ invoke: (channel: string, payload: unknown) => Promise<unknown>, hub: object }} parts
 * @returns {() => void} the disposer removing the routes.
 */
export function registerRoutes(ctx, { invoke, hub }) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void handle(req, res, { invoke, hub }).catch((cause) => {
        ctx.logger?.error(`dispatch: route failure: ${String(cause)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(cause) } });
        else res.end();
      });
    },
  });
}

async function handle(req, res, { invoke, hub }) {
  if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } });
  const pathname = new URL(req.url ?? '/', 'http://local').pathname;

  if (req.method === 'GET' && hub.isEventStream(pathname)) {
    hub.attachSse(res);
    req.on('close', () => res.end());
    return;
  }
  if (req.method === 'POST' && pathname.startsWith(INVOKE_PATH_PREFIX)) {
    const channel = pathname.slice(INVOKE_PATH_PREFIX.length);
    const body = await readBody(req);
    try {
      const value = await invoke(channel, body);
      sendJson(res, 200, { ok: true, value: value ?? null });
    } catch (cause) {
      const code = typeof cause?.code === 'string' && cause.code ? cause.code : 'failed';
      const status = code === 'unknown-channel' ? 404 : 200;
      sendJson(res, status, { ok: false, error: { code, message: cause instanceof Error ? cause.message : String(cause) } });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${req.method} ${pathname}` } });
}

/** loopback 判定:dsh webServer 只绑本机时全部来源都是 loopback,这里防御非默认绑定 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
