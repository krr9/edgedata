# Live Tail Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real-time WebSocket log streaming (live tail) to EdgeData using a Durable Object pub/sub hub.

**Architecture:** Ingest worker pushes events via service binding to a TailHub Durable Object in the query worker. Browser clients connect via WebSocket through the query worker, which authenticates and proxies to the DO. The DO filters and fans out events per-session.

**Tech Stack:** Cloudflare Workers Durable Objects (Hibernation API), WebSocket, service bindings, React

---

### Task 1: Create TailHub Durable Object

**Files:**
- Create: `workers/query-worker/src/tail-hub.ts`

**Step 1: Create the TailHub class**

Create `workers/query-worker/src/tail-hub.ts` with the full Durable Object implementation:

```typescript
import { DurableObject } from 'cloudflare:workers';

interface TailFilters {
  service?: string;
  env?: string;
  level?: string;
  index?: string;
  host?: string;
  keywords?: string[];
}

interface SessionAttachment {
  scope: DataScope;
  filters: TailFilters;
  paused: boolean;
  connectedAt: number;
}

interface DataScope {
  indexes: string[];
  services: string[];
  envs: string[];
  hosts: string[];
}

interface TailEvent {
  event_id: string;
  ts: string;
  index?: string;
  service: string;
  env: string;
  host: string;
  level: string;
  message: string;
  message_lc?: string;
  msg_hash?: string;
  trace_id?: string;
  request_id?: string;
  status?: number;
  duration_ms?: number;
  src_ip?: string;
  user_id?: string;
  attrs_json?: string;
}

const MAX_SESSIONS = 50;
const RING_BUFFER_SIZE = 500;
const AUTH_TIMEOUT_MS = 10_000;

export class TailHub extends DurableObject {
  private ringBuffer: TailEvent[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/push' && request.method === 'POST') {
      return this.handlePush(request);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/stats') {
      const sessions = this.ctx.getWebSockets('tail');
      return Response.json({
        active_sessions: sessions.length,
        ring_buffer_size: this.ringBuffer.length
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const sessions = this.ctx.getWebSockets('tail');
    if (sessions.length >= MAX_SESSIONS) {
      return Response.json(
        { error: 'Too many active tail sessions' },
        { status: 429 }
      );
    }

    const url = new URL(request.url);
    const scopeHeader = request.headers.get('X-Tail-Scope');
    let scope: DataScope = { indexes: [], services: [], envs: [], hosts: [] };
    if (scopeHeader) {
      try {
        scope = JSON.parse(scopeHeader);
      } catch {}
    }

    const filtersParam = url.searchParams.get('filters');
    let initialFilters: TailFilters = {};
    if (filtersParam) {
      try {
        initialFilters = JSON.parse(filtersParam);
      } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const attachment: SessionAttachment = {
      scope,
      filters: initialFilters,
      paused: false,
      connectedAt: Date.now()
    };

    this.ctx.acceptWebSocket(server, ['tail']);
    server.serializeAttachment(attachment);

    if (this.ringBuffer.length > 0) {
      const filtered = this.filterEventsForSession(this.ringBuffer, attachment);
      if (filtered.length > 0) {
        server.send(JSON.stringify({ type: 'catchup', events: filtered }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePush(request: Request): Promise<Response> {
    let events: TailEvent[];
    try {
      events = await request.json() as TailEvent[];
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return Response.json({ ok: true, pushed: 0 });
    }

    for (const event of events) {
      this.ringBuffer.push(event);
    }
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer = this.ringBuffer.slice(-RING_BUFFER_SIZE);
    }

    const sessions = this.ctx.getWebSockets('tail');
    for (const ws of sessions) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment || attachment.paused) continue;

      const filtered = this.filterEventsForSession(events, attachment);
      if (filtered.length > 0) {
        try {
          ws.send(JSON.stringify({ type: 'events', events: filtered }));
        } catch {
          // Client disconnected; will be cleaned up by webSocketClose
        }
      }
    }

    return Response.json({ ok: true, pushed: events.length, sessions: sessions.length });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;

    let msg: { type: string; filters?: TailFilters };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const attachment = (ws.deserializeAttachment() as SessionAttachment) || {
      scope: { indexes: [], services: [], envs: [], hosts: [] },
      filters: {},
      paused: false,
      connectedAt: Date.now()
    };

    if (msg.type === 'filter' && msg.filters) {
      attachment.filters = msg.filters;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: 'filter_ack', filters: msg.filters }));
    } else if (msg.type === 'pause') {
      attachment.paused = true;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: 'paused' }));
    } else if (msg.type === 'resume') {
      attachment.paused = false;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: 'resumed' }));
    }
  }

  async webSocketClose(ws: WebSocket): void {
    // Hibernation API handles cleanup automatically
  }

  async webSocketError(ws: WebSocket): void {
    ws.close(1011, 'Unexpected error');
  }

  private filterEventsForSession(events: TailEvent[], attachment: SessionAttachment): TailEvent[] {
    return events.filter((event) => {
      if (!this.matchesScope(event, attachment.scope)) return false;
      return this.matchesFilters(event, attachment.filters);
    });
  }

  private matchesScope(event: TailEvent, scope: DataScope): boolean {
    if (scope.indexes.length > 0 && !scope.indexes.includes('*')) {
      if (!scope.indexes.includes(event.index || 'default')) return false;
    }
    if (scope.services.length > 0 && !scope.services.includes('*')) {
      if (!scope.services.includes(event.service)) return false;
    }
    if (scope.envs.length > 0 && !scope.envs.includes('*')) {
      if (!scope.envs.includes(event.env)) return false;
    }
    if (scope.hosts.length > 0 && !scope.hosts.includes('*')) {
      if (!scope.hosts.includes(event.host)) return false;
    }
    return true;
  }

  private matchesFilters(event: TailEvent, filters: TailFilters): boolean {
    if (filters.service && event.service !== filters.service) return false;
    if (filters.env && event.env !== filters.env) return false;
    if (filters.level && event.level !== filters.level) return false;
    if (filters.index && (event.index || 'default') !== filters.index) return false;
    if (filters.host && event.host !== filters.host) return false;
    if (filters.keywords && filters.keywords.length > 0) {
      const haystack = (event.message_lc || event.message.toLowerCase());
      if (!filters.keywords.every((kw) => haystack.includes(kw.toLowerCase()))) return false;
    }
    return true;
  }
}
```

**Step 2: Verify file compiles**

Run: `npx tsc --noEmit --project workers/query-worker/tsconfig.json 2>&1 | head -20`

If no tsconfig exists for query-worker, just verify syntax with: `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`

**Step 3: Commit**

```bash
git add workers/query-worker/src/tail-hub.ts
git commit -m "feat(live-tail): add TailHub Durable Object class

WebSocket-based pub/sub hub using Hibernation API for real-time
log streaming. Supports per-session filters, RBAC scope enforcement,
ring buffer catch-up, and pause/resume."
```

---

### Task 2: Wire TailHub into query-worker config

**Files:**
- Modify: `workers/query-worker/wrangler.toml`
- Modify: `workers/query-worker/src/index.ts` (Env interface + export)

**Step 1: Add DO binding and migration to wrangler.toml**

Append to `workers/query-worker/wrangler.toml`:

```toml
[durable_objects]
bindings = [
  { name = "TAIL_HUB", class_name = "TailHub" }
]

[[migrations]]
tag = "v1"
new_classes = ["TailHub"]
```

**Step 2: Update Env interface in index.ts**

Add to the `Env` interface (after line 57 `OPS_WAE`):

```typescript
  TAIL_HUB: DurableObjectNamespace;
```

**Step 3: Re-export TailHub from the worker entry**

At the top of `workers/query-worker/src/index.ts`, add the re-export:

```typescript
export { TailHub } from './tail-hub.js';
```

**Step 4: Verify dry-run**

Run: `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`
Expected: Build succeeds with TailHub class exported.

**Step 5: Commit**

```bash
git add workers/query-worker/wrangler.toml workers/query-worker/src/index.ts
git commit -m "feat(live-tail): wire TailHub DO binding into query-worker"
```

---

### Task 3: Add /tail and /internal/tail-push routes to query worker

**Files:**
- Modify: `workers/query-worker/src/index.ts` (fetch handler, around line 4025-4213)

**Step 1: Add /tail WebSocket upgrade route**

In the `fetch` handler, add this block after the health check (after line 4037) and BEFORE the `await ensureRbacInitialized(env)` call:

```typescript
    if (url.pathname === '/tail' && request.headers.get('Upgrade') === 'websocket') {
      try {
        const tokenParam = url.searchParams.get('token');
        const authRequest = tokenParam
          ? new Request(request.url, {
              headers: new Headers([
                ...Array.from(request.headers.entries()),
                ['Authorization', `Bearer ${tokenParam}`]
              ])
            })
          : request;
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(authRequest, env);
        assertPermission(auth, 'search.read');

        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/ws';
        const doRequest = new Request(doUrl.toString(), {
          headers: new Headers([
            ['Upgrade', 'websocket'],
            ['X-Tail-Scope', JSON.stringify(auth.scope)]
          ])
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Auth failed' },
          { status: 401 }
        );
      }
    }
```

**Step 2: Add /internal/tail-push route**

Add this block right after the `/tail` WebSocket block (before RBAC init, since this is an internal call):

```typescript
    if (url.pathname === '/internal/tail-push' && request.method === 'POST') {
      try {
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doRequest = new Request(new URL('/push', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Push failed' },
          { status: 500 }
        );
      }
    }
```

**Step 3: Add /tail/stats route (optional, useful for debugging)**

Add after the push route:

```typescript
    if (url.pathname === '/tail/stats' && request.method === 'GET') {
      try {
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(request, env);
        assertPermission(auth, 'search.read');
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        return stub.fetch(new Request(new URL('/stats', request.url).toString()));
      } catch (error) {
        return errorResponse(error, requestCorsHeaders, 401);
      }
    }
```

**Step 4: Verify dry-run**

Run: `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts
git commit -m "feat(live-tail): add /tail WebSocket upgrade and /internal/tail-push routes"
```

---

### Task 4: Add service binding + tail push to ingest worker

**Files:**
- Modify: `workers/ingest-worker/wrangler.toml`
- Modify: `workers/ingest-worker/src/index.ts` (Env interface + processBatch)

**Step 1: Add service binding in wrangler.toml**

Append to `workers/ingest-worker/wrangler.toml`:

```toml
[[services]]
binding = "QUERY_SERVICE"
service = "query-worker"
```

**Step 2: Update Env interface**

In `workers/ingest-worker/src/index.ts`, add to the `Env` interface:

```typescript
  QUERY_SERVICE?: Fetcher;
```

Make it optional so the worker still functions without the binding (backward compatible).

**Step 3: Add tail push function**

Add a new function near the other write functions:

```typescript
async function pushToTailHub(events: NormalizedEvent[], env: Env): Promise<void> {
  if (!env.QUERY_SERVICE) return;
  try {
    await env.QUERY_SERVICE.fetch(
      new Request('https://internal/internal/tail-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(events)
      })
    );
  } catch {
    // Non-critical: tail push failure should never affect ingestion
  }
}
```

**Step 4: Call tail push from processBatch**

Modify the `processBatch` function to add the tail push as a 4th parallel operation. Change:

```typescript
  const results = await Promise.allSettled([
    writeEventsR2(events, env),
    writeWAE(events, env),
    writeTokens(events, env)
  ]);
```

to:

```typescript
  const results = await Promise.allSettled([
    writeEventsR2(events, env),
    writeWAE(events, env),
    writeTokens(events, env),
    pushToTailHub(events, env)
  ]);
```

Update the error logging loop to handle the 4th result:

```typescript
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const target = i === 0 ? 'events' : (i === 1 ? 'WAE' : (i === 2 ? 'tokens' : 'tail_push'));
      console.error(`[${requestId}] ${target} write failed`, result.reason);
      await writeOpsMetric(env, `${target.toLowerCase()}_write_failures`, 1).catch(() => undefined);
      if (target === 'events' || target === 'tokens') {
        await writeOpsMetric(env, 'iceberg_write_failures', 1).catch(() => undefined);
      }
    }
  }
```

**Step 5: Verify dry-run**

Run: `npx wrangler deploy --dry-run --config workers/ingest-worker/wrangler.toml`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add workers/ingest-worker/wrangler.toml workers/ingest-worker/src/index.ts
git commit -m "feat(live-tail): push ingested events to TailHub via service binding

Adds optional QUERY_SERVICE binding. Tail push runs in parallel with
existing writes and fails silently to never impact ingestion."
```

---

### Task 5: Add LiveTail view to Pages

**Files:**
- Modify: `pages/src/App.tsx`
- Modify: `pages/src/index.css`

**Step 1: Add 'livetail' to ViewMode type**

In `pages/src/App.tsx`, change the ViewMode type (line 5):

```typescript
type ViewMode = 'search' | 'dashboard' | 'saved' | 'scheduled' | 'alerts' | 'admin' | 'livetail';
```

**Step 2: Add the LiveTail component function**

Add a new component function inside `App.tsx` (before the main `App` component, or as an inline section). The component should include:

```typescript
function LiveTailView({ apiBase, apiToken }: { apiBase: string; apiToken: string | null }) {
  const [events, setEvents] = React.useState<LogEvent[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [filters, setFilters] = React.useState<{ service: string; env: string; level: string; keywords: string }>({
    service: '', env: '', level: '', keywords: ''
  });
  const [rate, setRate] = React.useState(0);
  const [selectedEvent, setSelectedEvent] = React.useState<LogEvent | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const eventsEndRef = React.useRef<HTMLDivElement | null>(null);
  const autoScrollRef = React.useRef(true);
  const rateCountRef = React.useRef(0);
  const maxEvents = 2000;

  const wsUrl = React.useMemo(() => {
    const base = apiBase.replace(/^http/, 'ws');
    const params = new URLSearchParams();
    if (apiToken) params.set('token', apiToken);
    return `${base}/tail?${params.toString()}`;
  }, [apiBase, apiToken]);

  React.useEffect(() => {
    const rateInterval = setInterval(() => {
      setRate(rateCountRef.current);
      rateCountRef.current = 0;
    }, 1000);
    return () => clearInterval(rateInterval);
  }, []);

  const connect = React.useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      const f: Record<string, unknown> = {};
      if (filters.service) f.service = filters.service;
      if (filters.env) f.env = filters.env;
      if (filters.level) f.level = filters.level;
      if (filters.keywords) f.keywords = filters.keywords.split(/\s+/).filter(Boolean);
      if (Object.keys(f).length > 0) {
        ws.send(JSON.stringify({ type: 'filter', filters: f }));
      }
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'events' || msg.type === 'catchup') {
          const newEvents = msg.events as LogEvent[];
          rateCountRef.current += newEvents.length;
          setEvents((prev) => {
            const merged = [...prev, ...newEvents];
            return merged.length > maxEvents ? merged.slice(-maxEvents) : merged;
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(() => {
        if (wsRef.current === ws) connect();
      }, 2000);
    };

    ws.onerror = () => ws.close();
  }, [wsUrl, filters]);

  React.useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  React.useEffect(() => {
    if (autoScrollRef.current && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  const sendFilter = React.useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const f: Record<string, unknown> = {};
    if (filters.service) f.service = filters.service;
    if (filters.env) f.env = filters.env;
    if (filters.level) f.level = filters.level;
    if (filters.keywords) f.keywords = filters.keywords.split(/\s+/).filter(Boolean);
    wsRef.current.send(JSON.stringify({ type: 'filter', filters: f }));
  }, [filters]);

  const togglePause = React.useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (paused) {
      wsRef.current.send(JSON.stringify({ type: 'resume' }));
      setPaused(false);
      autoScrollRef.current = true;
    } else {
      wsRef.current.send(JSON.stringify({ type: 'pause' }));
      setPaused(true);
      autoScrollRef.current = false;
    }
  }, [paused]);

  const clearEvents = React.useCallback(() => {
    setEvents([]);
  }, []);

  const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    autoScrollRef.current = atBottom;
  }, []);

  return (
    <div className="livetail-view">
      <div className="livetail-toolbar">
        <div className="livetail-filters">
          <input
            type="text"
            placeholder="service"
            value={filters.service}
            onChange={(e) => setFilters((f) => ({ ...f, service: e.target.value }))}
            onBlur={sendFilter}
            onKeyDown={(e) => e.key === 'Enter' && sendFilter()}
            className="livetail-input"
          />
          <input
            type="text"
            placeholder="env"
            value={filters.env}
            onChange={(e) => setFilters((f) => ({ ...f, env: e.target.value }))}
            onBlur={sendFilter}
            onKeyDown={(e) => e.key === 'Enter' && sendFilter()}
            className="livetail-input"
          />
          <select
            value={filters.level}
            onChange={(e) => {
              setFilters((f) => ({ ...f, level: e.target.value }));
              setTimeout(sendFilter, 0);
            }}
            className="livetail-input"
          >
            <option value="">all levels</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <input
            type="text"
            placeholder="keywords (space separated)"
            value={filters.keywords}
            onChange={(e) => setFilters((f) => ({ ...f, keywords: e.target.value }))}
            onBlur={sendFilter}
            onKeyDown={(e) => e.key === 'Enter' && sendFilter()}
            className="livetail-input livetail-keywords"
          />
        </div>
        <div className="livetail-controls">
          <span className={`livetail-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'connected' : 'reconnecting...'}
          </span>
          <span className="livetail-rate">{rate} events/s</span>
          <button onClick={togglePause} className={`livetail-btn ${paused ? 'paused' : ''}`}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clearEvents} className="livetail-btn">Clear</button>
        </div>
      </div>

      <div className="livetail-stream" onScroll={handleScroll}>
        {events.length === 0 && (
          <div className="livetail-empty">
            {connected ? 'Waiting for events...' : 'Connecting...'}
          </div>
        )}
        {events.map((event, i) => (
          <div
            key={`${event.event_id}-${i}`}
            className={`livetail-event level-${event.level}`}
            onClick={() => setSelectedEvent(event)}
          >
            <span className="livetail-ts">{new Date(event.ts).toISOString().slice(11, 23)}</span>
            <span className={`livetail-level ${event.level}`}>{event.level.toUpperCase().padEnd(5)}</span>
            <span className="livetail-svc">{event.service}</span>
            <span className="livetail-msg">{event.message.length > 300 ? event.message.slice(0, 300) + '...' : event.message}</span>
          </div>
        ))}
        <div ref={eventsEndRef} />
      </div>

      {selectedEvent && (
        <div className="drawer-overlay" onClick={() => setSelectedEvent(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <header className="drawer-header">
              <h3>Event Detail</h3>
              <button onClick={() => setSelectedEvent(null)}>Close</button>
            </header>
            <div className="detail-grid">
              <div className="detail-row"><strong>Timestamp</strong><span>{selectedEvent.ts}</span></div>
              <div className="detail-row"><strong>Service</strong><span>{selectedEvent.service}</span></div>
              <div className="detail-row"><strong>Env</strong><span>{selectedEvent.env}</span></div>
              <div className="detail-row"><strong>Host</strong><span>{selectedEvent.host}</span></div>
              <div className="detail-row"><strong>Level</strong><span className={`badge ${selectedEvent.level}`}>{selectedEvent.level}</span></div>
              {selectedEvent.status !== undefined && <div className="detail-row"><strong>Status</strong><span>{selectedEvent.status}</span></div>}
              {selectedEvent.trace_id && <div className="detail-row"><strong>Trace ID</strong><span>{selectedEvent.trace_id}</span></div>}
              {selectedEvent.request_id && <div className="detail-row"><strong>Request ID</strong><span>{selectedEvent.request_id}</span></div>}
            </div>
            <div className="detail-row"><strong>Message</strong><pre className="detail-message">{selectedEvent.message}</pre></div>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Add the nav button and view render**

Find the navigation section in `App.tsx` and add a "Live Tail" button alongside the other view buttons. Add it in the nav area where the other buttons are:

```typescript
<button className={view === 'livetail' ? 'active' : ''} onClick={() => setView('livetail')}>Live Tail</button>
```

Add the view render in the main content area alongside the other view conditionals:

```typescript
{view === 'livetail' && (
  <LiveTailView apiBase={API_BASE} apiToken={apiToken} />
)}
```

**Step 4: Verify Pages build**

Run: `npm -C pages run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add pages/src/App.tsx
git commit -m "feat(live-tail): add LiveTail view component with WebSocket streaming"
```

---

### Task 6: Add LiveTail CSS

**Files:**
- Modify: `pages/src/index.css`

**Step 1: Add live tail styles**

Append to `pages/src/index.css`:

```css
/* ── Live Tail ─────────────────────────────────── */
.livetail-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 64px);
  overflow: hidden;
}

.livetail-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-secondary, #1a1a2e);
  border-bottom: 1px solid var(--border, #2a2a4a);
  flex-wrap: wrap;
}

.livetail-filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.livetail-input {
  padding: 6px 10px;
  font-size: 13px;
  border-radius: 4px;
  border: 1px solid var(--border, #2a2a4a);
  background: var(--bg-primary, #0f0f23);
  color: var(--text-primary, #e0e0e0);
  min-width: 100px;
}

.livetail-input:focus {
  outline: none;
  border-color: var(--accent, #6c63ff);
}

.livetail-keywords {
  min-width: 200px;
}

.livetail-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.livetail-status {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 10px;
}

.livetail-status.connected {
  color: #2ecc71;
  background: rgba(46, 204, 113, 0.12);
}

.livetail-status.disconnected {
  color: #e74c3c;
  background: rgba(231, 76, 60, 0.12);
}

.livetail-rate {
  font-size: 12px;
  color: var(--text-secondary, #888);
  font-variant-numeric: tabular-nums;
  min-width: 90px;
  text-align: right;
}

.livetail-btn {
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 4px;
  border: 1px solid var(--border, #2a2a4a);
  background: var(--bg-secondary, #1a1a2e);
  color: var(--text-primary, #e0e0e0);
  cursor: pointer;
  transition: background 0.15s;
}

.livetail-btn:hover {
  background: var(--bg-hover, #252545);
}

.livetail-btn.paused {
  background: rgba(231, 76, 60, 0.18);
  border-color: #e74c3c;
  color: #e74c3c;
}

.livetail-stream {
  flex: 1;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.65;
  padding: 4px 0;
  background: var(--bg-primary, #0f0f23);
}

.livetail-empty {
  padding: 48px;
  text-align: center;
  color: var(--text-secondary, #888);
  font-size: 14px;
}

.livetail-event {
  display: flex;
  gap: 10px;
  padding: 2px 16px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.1s;
}

.livetail-event:hover {
  background: rgba(255, 255, 255, 0.03);
}

.livetail-event.level-error {
  border-left-color: #e74c3c;
}

.livetail-event.level-warn {
  border-left-color: #f39c12;
}

.livetail-event.level-info {
  border-left-color: transparent;
}

.livetail-event.level-debug {
  border-left-color: transparent;
  opacity: 0.6;
}

.livetail-ts {
  color: var(--text-secondary, #888);
  white-space: nowrap;
  flex-shrink: 0;
}

.livetail-level {
  font-weight: 700;
  width: 44px;
  flex-shrink: 0;
  text-align: center;
  font-size: 10.5px;
  padding: 1px 0;
}

.livetail-level.error { color: #e74c3c; }
.livetail-level.warn  { color: #f39c12; }
.livetail-level.info  { color: #3498db; }
.livetail-level.debug { color: #888; }

.livetail-svc {
  color: var(--accent, #6c63ff);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 80px;
}

.livetail-msg {
  color: var(--text-primary, #e0e0e0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

**Step 2: Verify build**

Run: `npm -C pages run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add pages/src/index.css
git commit -m "feat(live-tail): add live tail stream styling

Monospace log stream with level-colored left border, connection
status indicators, filter bar, and rate display."
```

---

### Task 7: Verification

**Step 1: Dry-run all worker builds**

```bash
npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml
npx wrangler deploy --dry-run --config workers/ingest-worker/wrangler.toml
```

Expected: Both succeed without errors.

**Step 2: Build Pages**

```bash
npm -C pages run build
```

Expected: Build succeeds.

**Step 3: Run existing unit tests**

```bash
npm run test:unit
```

Expected: All existing tests pass (no regressions).

**Step 4: Run access config tests**

```bash
npm run test:access-config
```

Expected: Pass (wrangler config still valid).

---

### Task 8: Update README and API docs

**Files:**
- Modify: `README.md`

**Step 1: Add live tail to API endpoints section**

Under "Query worker:" endpoints, add:

```markdown
- `GET /tail` (WebSocket upgrade; real-time log streaming with per-session filters)
- `GET /tail/stats` (tail session stats)
```

**Step 2: Add live tail to Components section**

Under the query-worker component description, add mention of the TailHub Durable Object.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add live tail endpoints to README"
```
