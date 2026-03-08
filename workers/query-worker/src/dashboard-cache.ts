import { DurableObject } from 'cloudflare:workers';

interface CacheEnvelope {
  expires_at: number;
  payload: unknown;
}

export class DashboardCache extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/cache/get' && request.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      if (!key) return Response.json({ error: 'key is required' }, { status: 400 });
      const entry = await this.ctx.storage.get<CacheEnvelope>(key);
      if (!entry) return Response.json({ hit: false }, { status: 200 });
      if (entry.expires_at <= Date.now()) {
        await this.ctx.storage.delete(key);
        return Response.json({ hit: false }, { status: 200 });
      }
      return Response.json({ hit: true, payload: entry.payload }, { status: 200 });
    }

    if (url.pathname === '/cache/set' && request.method === 'POST') {
      const body = await request.json() as {
        key?: string;
        ttl_seconds?: number;
        payload?: unknown;
      };
      const key = String(body.key || '').trim();
      if (!key) return Response.json({ error: 'key is required' }, { status: 400 });
      const ttl = Math.max(1, Math.min(120, Number(body.ttl_seconds) || 20));
      const expiresAt = Date.now() + ttl * 1000;
      await this.ctx.storage.put(key, {
        expires_at: expiresAt,
        payload: body.payload ?? {}
      } satisfies CacheEnvelope);
      return Response.json({ ok: true, key, expires_at: expiresAt }, { status: 200 });
    }

    if (url.pathname === '/cache/delete' && request.method === 'POST') {
      const body = await request.json() as { key?: string };
      const key = String(body.key || '').trim();
      if (!key) return Response.json({ error: 'key is required' }, { status: 400 });
      await this.ctx.storage.delete(key);
      return Response.json({ ok: true }, { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  }
}
