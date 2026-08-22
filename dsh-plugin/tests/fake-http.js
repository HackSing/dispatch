/**
 * Minimal node:http request/response doubles for driving the prefix handler.
 *
 * @module dsh-dispatch/tests/fake-http
 */
import { EventEmitter } from 'node:events';

export function fakeReq({ method = 'POST', url = '/api/dispatch/invoke/task:list', body = null, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress };
  setImmediate(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

export function fakeRes() {
  const res = { statusCode: null, headers: null, chunks: [], ended: false };
  res.headersSent = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk) => res.chunks.push(String(chunk));
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk));
    res.ended = true;
  };
  res.body = () => {
    const raw = res.chunks.join('');
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  res.frames = () => res.chunks.join('');
  return res;
}

/** 驱动 handler 直到 response ended(或超时),返回该 response */
export async function drive(handler, req, res, timeoutMs = 5000) {
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handler did not settle')), timeoutMs);
    Object.defineProperty(res, 'ended', {
      get() {
        return res._ended;
      },
      set(v) {
        res._ended = v;
        if (v) {
          clearTimeout(timer);
          resolve();
        }
      },
    });
  });
  handler(req, res);
  await done;
  return res;
}
