#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const requireApiBase = args.has('--require-api-base');

const rawApiBase = String(process.env.VITE_QUERY_API_BASE || '').trim();

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`WARN: ${message}`);
}

if (!rawApiBase) {
  if (requireApiBase) {
    fail('VITE_QUERY_API_BASE is required for Pages deploys. Set it to the customer-specific query-worker origin before building.');
  }
  warn('VITE_QUERY_API_BASE is not set. The built app will show a login/config error until this is provided.');
  process.exit(0);
}

let apiBase;
try {
  apiBase = new URL(rawApiBase);
} catch {
  fail(`VITE_QUERY_API_BASE must be a valid absolute URL. Received: ${rawApiBase}`);
}

if (apiBase.protocol !== 'https:') {
  fail(`VITE_QUERY_API_BASE must use https. Received: ${rawApiBase}`);
}

const deniedHostnames = new Map([
  ['query-worker.rvkishore.workers.dev', 'legacy personal development query-worker hostname'],
  ['query-worker.example.workers.dev', 'placeholder example hostname']
]);

const deniedReason = deniedHostnames.get(apiBase.hostname);
if (deniedReason) {
  fail(
    `VITE_QUERY_API_BASE points to ${deniedReason} (${apiBase.hostname}). Use the customer deployment's own query-worker hostname or custom domain instead.`
  );
}

if (apiBase.hostname.endsWith('.workers.dev')) {
  warn(
    `VITE_QUERY_API_BASE uses a workers.dev hostname (${apiBase.hostname}). Ensure Cloudflare Access is enabled on that exact hostname or use an Access-protected custom domain.`
  );
}

console.log(`OK: Pages API base -> ${apiBase.origin}`);
