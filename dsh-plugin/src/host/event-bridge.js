/**
 * Event hub: the plugin's counterpart of the standalone app's window
 * broadcast. Core callbacks push (channel, payload); every attached SSE
 * response gets `event: <channel>` frames. Named events keep the client's
 * EventSource dispatch isomorphic to the preload `on(channel, listener)`.
 *
 * @module dsh-dispatch/host/event-bridge
 */
import { EVENT_STREAM_PATH, SSE_PING_MS } from './constants.js';

export function createEventHub() {
  /** @type {Set<{ send: (frame: string) => void, close: () => void }>} */
  const sinks = new Set();

  function broadcast(channel, payload) {
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    for (const sink of sinks) sink.send(frame);
  }

  /**
   * Turn one HTTP response into an SSE sink. Heartbeat comments keep
   * intermediaries from reaping the idle stream; close detaches cleanly.
   */
  function attachSse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    const sink = {
      send: (frame) => res.write(frame),
      close: () => {
        clearInterval(ping);
        sinks.delete(sink);
        res.end();
      },
    };
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    ping.unref?.();
    sinks.add(sink);
    return sink;
  }

  return {
    broadcast,
    attachSse,
    isEventStream(pathname) {
      return pathname === EVENT_STREAM_PATH;
    },
    get listenerCount() {
      return sinks.size;
    },
    dispose() {
      for (const sink of [...sinks]) sink.close();
    },
  };
}
