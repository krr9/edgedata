# Live Tail Design

**Date:** 2026-03-06
**Status:** Approved

## Problem

EdgeData has no real-time log streaming. Users must repeatedly search to see new events. Every serious log product (Datadog, Splunk, Papertrail) has a live tail view -- a real-time stream of logs with filtering that stays open during incidents.

## Solution

Real-time WebSocket-based live tail using a Durable Object as a pub/sub hub.

## Architecture

```
Agent/App → POST /ingest → Ingest Worker
                              ├── R2 writes (existing)
                              ├── WAE writes (existing)
                              └── ctx.waitUntil → service binding → Query Worker /internal/tail-push
                                                                      ↓
                                                                  TailHub DO
                                                                      │
Browser → WebSocket /tail → Query Worker (auth) → TailHub DO ──ws──► UI
```

### Components

1. **TailHub Durable Object** (new, in query-worker)
   - Accepts WebSocket connections from authenticated users
   - Maintains per-connection filter state via Hibernation API attachments
   - Receives pushed events from ingest worker and broadcasts to matching sessions
   - Ring buffer of last 500 events for catch-up on connect
   - Max 50 concurrent sessions

2. **Query Worker additions**
   - `GET /tail` — WebSocket upgrade with auth (cookie or `?token=` param)
   - `POST /internal/tail-push` — receives events from ingest, forwards to DO
   - New Env bindings: `TAIL_HUB` (DurableObjectNamespace)

3. **Ingest Worker additions**
   - Service binding to query-worker
   - After processBatch, push normalized events to `/internal/tail-push` (async, non-blocking, failure-tolerant)

4. **Pages UI additions**
   - New "Live Tail" view in navigation
   - WebSocket connection management with reconnect
   - Filter bar (service, env, level, keyword)
   - Streaming event display with auto-scroll and pause/resume
   - Rate indicator and connection status

### Auth flow for WebSocket

1. Client sends `GET /tail?token=<bearer>` with `Upgrade: websocket`
2. Query worker authenticates via bearer token or cookies (Access JWT / session)
3. On success, resolves RBAC scope, forwards to TailHub DO with scope in headers
4. TailHub stores scope on the WebSocket attachment for server-side enforcement

### Message protocol (WebSocket)

Client → Server:
- `{ "type": "filter", "filters": { "service": "payments", "level": "error" } }`
- `{ "type": "pause" }`
- `{ "type": "resume" }`

Server → Client:
- `{ "type": "events", "events": [...] }`
- `{ "type": "catchup", "events": [...] }`
- `{ "type": "stats", "sessions": 5, "rate": 42 }`
- `{ "type": "error", "message": "..." }`
