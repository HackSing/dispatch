/**
 * dsh-dispatch — host half.
 *
 * Mounts the dispatch task inbox & agent scheduler into the dsh service
 * process: the full core runtime (SQLite stores, 30s scheduler, worktree
 * execution, follow-up sessions, archives) assembled in core-runtime.js,
 * exposed to the browser over `/api/dispatch/*` HTTP + SSE. Data home is
 * `~/.dispatch` (override: DISPATCH_HOME env) — shared with the standalone
 * Dispatch app; running both at once is not supported.
 *
 * Fail-soft: if the runtime cannot assemble (e.g. the database is locked by
 * the standalone app), routes still register and answer `runtime-unavailable`
 * instead of crashing the dsh boot.
 *
 * @module dsh-dispatch
 */
import { createRequire } from 'node:module';
import { PLUGIN_ID } from './constants.js';
import { createEventHub } from './event-bridge.js';
import { createIpcBridge } from './ipc-bridge.js';
import { createDispatchRuntime } from './core-runtime.js';
import { registerRoutes } from './routes.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

/** Plugin name in the cordis roster. */
export const name = '@aiwaretop/dsh-dispatch';

/** Hard requirements: none — the web server is reached through an optional inject. */
export const inject = [];

/**
 * Mount the plugin.
 * @param {object} ctx - the host plugin context.
 */
export function apply(ctx) {
  const logger = adaptLogger(ctx.logger, PLUGIN_ID);
  const hub = createEventHub();

  let runtime = null;
  try {
    runtime = createDispatchRuntime({ broadcast: hub.broadcast, logger, version });
  } catch (cause) {
    logger.error(`Dispatch runtime 装配失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const invoke = createIpcBridge({ runtime, broadcast: hub.broadcast });

  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => registerRoutes(routeCtx, { invoke, hub }), '@aiwaretop/dsh-dispatch: routes');
  });

  ctx.effect(() => {
    let closed = false;
    return () => {
      if (closed) return undefined;
      closed = true;
      hub.dispose();
      return runtime?.dispose();
    };
  }, '@aiwaretop/dsh-dispatch: runtime');
}

/** dsh 的 logger 可能缺方法或缺席;补齐为满形状,缺省落 console */
function adaptLogger(raw, tag) {
  const base = raw ?? console;
  const pick = (method) => (typeof base[method] === 'function' ? base[method] : console[method]);
  return {
    info: (msg) => pick('info').call(base, `[${tag}] ${msg}`),
    warn: (msg) => pick('warn').call(base, `[${tag}] ${msg}`),
    error: (msg) => pick('error').call(base, `[${tag}] ${msg}`),
  };
}
