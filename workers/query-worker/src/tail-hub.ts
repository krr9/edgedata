/**
 * TailHub Durable Object — WebSocket pub/sub hub for live tail streaming.
 * Uses Cloudflare Durable Object Hibernation API for efficient WebSocket handling.
 */

import { DurableObject } from 'cloudflare:workers';

// --- Interfaces ---

interface TailFilters {
  service?: string;
  env?: string;
  level?: string;
  index?: string;
  host?: string;
  keywords?: string[];
}

interface DataScope {
  indexes: string[];
  services: string[];
  envs: string[];
  hosts: string[];
}

interface SessionAttachment {
  scope: DataScope;
  filters: TailFilters;
  paused: boolean;
  connectedAt: number;
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

// --- Constants ---

const MAX_SESSIONS = 50;
const RING_BUFFER_SIZE = 500;

// --- TailHub Durable Object ---

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

    if (url.pathname === '/stats' && request.method === 'GET') {
      const sessions = this.ctx.getWebSockets('tail');
      return Response.json({
        active_sessions: sessions.length,
        ring_buffer_size: this.ringBuffer.length,
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

    const scopeHeader = request.headers.get('X-Tail-Scope');
    let scope: DataScope = { indexes: [], services: [], envs: [], hosts: [] };
    if (scopeHeader) {
      try {
        scope = JSON.parse(scopeHeader) as DataScope;
      } catch {
        // Invalid JSON — use empty scope
      }
    }

    const url = new URL(request.url);
    const filtersParam = url.searchParams.get('filters');
    let initialFilters: TailFilters = {};
    if (filtersParam) {
      try {
        initialFilters = JSON.parse(filtersParam) as TailFilters;
      } catch {
        // Invalid JSON — use empty filters
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const attachment: SessionAttachment = {
      scope,
      filters: initialFilters,
      paused: false,
      connectedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server, ['tail']);
    server.serializeAttachment(attachment);

    // Send catch-up events from ring buffer (filtered for this session)
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
      events = (await request.json()) as TailEvent[];
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return Response.json({ ok: true, pushed: 0, sessions: 0 });
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

    return Response.json({
      ok: true,
      pushed: events.length,
      sessions: sessions.length,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: { type: string; filters?: TailFilters };
    try {
      msg = JSON.parse(message) as { type: string; filters?: TailFilters };
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const attachment = (ws.deserializeAttachment() as SessionAttachment) ?? {
      scope: { indexes: [], services: [], envs: [], hosts: [] },
      filters: {},
      paused: false,
      connectedAt: Date.now(),
    };

    if (msg.type === 'filter' && msg.filters !== undefined) {
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

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, 'Unexpected error');
  }

  private filterEventsForSession(
    events: TailEvent[],
    attachment: SessionAttachment
  ): TailEvent[] {
    return events.filter((event) => {
      if (!this.matchesScope(event, attachment.scope)) return false;
      return this.matchesFilters(event, attachment.filters);
    });
  }

  private matchesScope(event: TailEvent, scope: DataScope): boolean {
    if (scope.indexes.length > 0 && !scope.indexes.includes('*')) {
      if (!scope.indexes.includes(event.index ?? 'default')) return false;
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
    if (filters.service !== undefined && event.service !== filters.service)
      return false;
    if (filters.env !== undefined && event.env !== filters.env) return false;
    if (filters.level !== undefined && event.level !== filters.level)
      return false;
    if (
      filters.index !== undefined &&
      (event.index ?? 'default') !== filters.index
    )
      return false;
    if (filters.host !== undefined && event.host !== filters.host)
      return false;
    if (filters.keywords !== undefined && filters.keywords.length > 0) {
      const haystack = event.message_lc ?? event.message.toLowerCase();
      if (
        !filters.keywords.every((kw) =>
          haystack.includes(kw.toLowerCase())
        )
      )
        return false;
    }
    return true;
  }
}
