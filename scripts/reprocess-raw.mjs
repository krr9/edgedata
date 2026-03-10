#!/usr/bin/env node

const INGEST_URL = process.env.INGEST_URL || '';
const REPROCESS_SECRET = process.env.REPROCESS_SECRET || process.env.INGEST_SECRET || '';

if (!INGEST_URL) {
  console.error('Missing INGEST_URL');
  process.exit(1);
}

if (!REPROCESS_SECRET) {
  console.error('Missing REPROCESS_SECRET (or INGEST_SECRET)');
  process.exit(1);
}

const args = process.argv.slice(2);
const payload = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--from' && args[i + 1]) payload.from = args[++i];
  else if (arg === '--to' && args[i + 1]) payload.to = args[++i];
  else if (arg === '--index' && args[i + 1]) payload.index = args[++i];
  else if (arg === '--service' && args[i + 1]) payload.service = args[++i];
  else if (arg === '--env' && args[i + 1]) payload.env = args[++i];
  else if (arg === '--max-objects' && args[i + 1]) payload.max_objects = Number(args[++i]);
  else if (arg === '--apply') payload.dry_run = false;
}

if (payload.dry_run === undefined) {
  payload.dry_run = true;
}

async function run() {
  const response = await fetch(`${INGEST_URL}/reprocess`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${REPROCESS_SECRET}`
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(body, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
