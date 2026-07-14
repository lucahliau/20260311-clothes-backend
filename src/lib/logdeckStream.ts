/**
 * logdeck mirror stream — ships every pino log line to the self-hosted logdeck hub
 * (central log collation + error tracking for all projects; repo: ~/Desktop/logdeck).
 *
 * Used via `pino.multistream` in `logger.ts`, production only. Design rules:
 * NEVER throws, NEVER blocks a request, silently no-ops when LOGDECK_URL/LOGDECK_KEY
 * are unset, batches + retries with backoff, drops logs (bounded queue) rather than
 * leaking memory when the hub is unreachable.
 *
 * The hub maps pino numeric levels (10..60), pulls `req.id` into its request_id
 * column, and runs its own secret redaction on top of pino's REDACT_PATHS.
 */

interface LogdeckStreamOptions {
  url: string;
  key: string;
  service?: string;
  env?: string;
}

interface LogdeckEntry {
  ts?: number;
  level?: number | string;
  message: string;
  request_id?: string;
  stack?: string;
  service?: string;
  env?: string;
  context?: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 2_000;
const MAX_BATCH = 100;
const MAX_QUEUE = 2_000;
const OMIT_KEYS = new Set(["time", "level", "msg", "pid", "hostname", "v"]);

export function logdeckPinoStream(opts: LogdeckStreamOptions): { write: (line: string) => void } {
  const base = opts.url.replace(/\/$/, "");
  let queue: LogdeckEntry[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let consecutiveFailures = 0;

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue.splice(0, MAX_BATCH);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
        body: JSON.stringify({ logs: batch }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok && res.status !== 429) throw new Error(`ingest HTTP ${res.status}`);
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      // Requeue a few times, then drop — the app must never pay for hub downtime.
      if (consecutiveFailures <= 3) queue = batch.concat(queue).slice(0, MAX_QUEUE);
    } finally {
      flushing = false;
      if (queue.length > 0 && !timer) {
        const backoff = Math.min(30_000, FLUSH_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 4));
        timer = setTimeout(() => void flush(), backoff);
        timer.unref();
      }
    }
  }

  return {
    write(line: string): void {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const req = o.req as { id?: string } | undefined;
        const err = o.err as { stack?: string } | undefined;
        const entry: LogdeckEntry = {
          ts: typeof o.time === "number" ? o.time : undefined,
          level: o.level as number | string,
          message: typeof o.msg === "string" ? o.msg : "",
          request_id: req?.id ?? (o.reqId as string | undefined),
          stack: err?.stack,
          service: opts.service,
          env: opts.env,
        };
        const context: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) {
          if (!OMIT_KEYS.has(k)) context[k] = v;
        }
        if (Object.keys(context).length > 0) entry.context = context;

        queue.push(entry);
        if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE); // drop oldest
        if (queue.length >= MAX_BATCH) void flush();
        else if (!timer) {
          timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
          timer.unref();
        }
      } catch {
        // Never throw inside a pino stream.
      }
    },
  };
}
