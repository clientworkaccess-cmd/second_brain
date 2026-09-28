/**
 * Server-Sent Events.
 *
 * SSE rather than WebSocket because the data is one-way server→client, and SSE
 * inherits TLS, auth, reverse-proxy config and browser auto-reconnect from
 * plain HTTP. A WebSocket would mean re-solving all four.
 */

export interface SseHandle {
  send: (event: string, data: unknown) => void;
  close: () => void;
}

export function sseResponse(start: (handle: SseHandle) => void | (() => void)): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | void;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      };

      // A comment frame immediately, so proxies and the browser commit to the
      // stream instead of waiting on the first real event.
      controller.enqueue(encoder.encode(': open\n\n'));

      cleanup = start({ send, close });
    },
    cancel() {
      // Client navigated away or refreshed. Drop the subscription; the work
      // itself keeps running — that is the entire point of the job record.
      if (typeof cleanup === 'function') cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Belt and braces for reverse proxies that buffer by default. Caddy also
      // needs `flush_interval -1` on these routes — see the Caddyfile.
      'X-Accel-Buffering': 'no',
    },
  });
}
