/**
 * Minimal cordis context double: records effects and optional injects so a
 * test can drive them deterministically.
 *
 * @module dsh-dispatch/tests/fake-context
 */
export function fakeContext({ webServer = true } = {}) {
  const effects = [];
  const injects = [];
  const registrations = [];
  const ctx = {
    logger: silentLogger(),
    effect(fn, label) {
      // cordis 语义:立即执行 fn,返回值即清理函数
      const disposer = fn();
      effects.push({ disposer, label });
    },
    inject(deps, cb) {
      injects.push({ deps, cb });
    },
  };
  if (webServer) {
    ctx.webServer = {
      register(spec) {
        registrations.push(spec);
        return () => registrations.splice(registrations.indexOf(spec), 1);
      },
    };
  }
  return {
    ctx,
    effects,
    injects,
    registrations,
    /** run every recorded inject with the context itself */
    runInjects() {
      for (const { cb } of injects) cb(ctx);
    },
    /** run every recorded effect disposer in registration order */
    runDisposers() {
      const disposers = effects.map(({ disposer }) => disposer);
      return disposers.filter((d) => typeof d === 'function');
    },
  };
}

function silentLogger() {
  const log = (level) => (msg) => {
    if (process.env.DISPATCH_TEST_VERBOSE) console.error(`[${level}] ${msg}`);
  };
  return { info: log('info'), warn: log('warn'), error: log('error') };
}
