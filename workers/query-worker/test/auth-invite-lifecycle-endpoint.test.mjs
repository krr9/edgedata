import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const RUN_INTEGRATION = process.env.RUN_AUTH_INVITE_INTEGRATION === '1';
const WRANGLER_CONFIG_PATH = fileURLToPath(new URL('../wrangler.integration.toml', import.meta.url));

async function runIntegrationTests() {
  const { unstable_startWorker } = await import('wrangler');
  const worker = await unstable_startWorker({
    config: WRANGLER_CONFIG_PATH
  });

  try {
    const base = 'http://localhost';
    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-admin-token'
    };

    const createInviteRes = await worker.fetch(`${base}/auth/invite`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'invitee@example.com',
        auth_mode: 'local_password',
        role_ids: ['viewer']
      })
    });
    assert.equal(createInviteRes.status, 201, 'create invite should return 201');

    const pendingRes = await worker.fetch(`${base}/auth/invites?status=pending&limit=20`, {
      headers: { Authorization: 'Bearer test-admin-token' }
    });
    assert.equal(pendingRes.status, 200, 'list pending invites should return 200');
    const pending = await pendingRes.json();
    assert.ok(Array.isArray(pending), 'pending invite response should be an array');
    assert.ok(pending.length >= 1, 'pending invites should include created invite');

    const inviteToResend = pending.find((row) => row.email === 'invitee@example.com');
    assert.ok(inviteToResend, 'created invite should be in pending list');

    const resendRes = await worker.fetch(`${base}/auth/invite/resend`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: inviteToResend.id })
    });
    assert.equal(resendRes.status, 201, 'resend invite should return 201');
    const resent = await resendRes.json();
    assert.ok(resent.id, 'resend response should include invitation id');
    assert.ok(resent.invite_token, 'resend response should include invite token');

    const acceptRes = await worker.fetch(`${base}/auth/invite/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resent.invite_token,
        password: 'StrongPass!123'
      })
    });
    assert.equal(acceptRes.status, 200, 'accept invite should return 200');

    const pendingRes2 = await worker.fetch(`${base}/auth/invites?status=pending&limit=20`, {
      headers: { Authorization: 'Bearer test-admin-token' }
    });
    assert.equal(pendingRes2.status, 200);
    const pendingAfterAccept = await pendingRes2.json();
    assert.equal(
      pendingAfterAccept.some((row) => row.email === 'invitee@example.com'),
      false,
      'accepted invite should not remain pending'
    );

    const createInviteRes2 = await worker.fetch(`${base}/auth/invite`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: 'second@example.com',
        auth_mode: 'local_password',
        role_ids: ['viewer']
      })
    });
    assert.equal(createInviteRes2.status, 201);

    const pendingRes3 = await worker.fetch(`${base}/auth/invites?status=pending&limit=20`, {
      headers: { Authorization: 'Bearer test-admin-token' }
    });
    const pendingThird = await pendingRes3.json();
    const secondInvite = pendingThird.find((row) => row.email === 'second@example.com');
    assert.ok(secondInvite, 'second invite should be pending');

    const revokeRes = await worker.fetch(`${base}/auth/invite/revoke`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: secondInvite.id })
    });
    assert.equal(revokeRes.status, 200, 'revoke invite should return 200');

    const allRes = await worker.fetch(`${base}/auth/invites?status=all&limit=100`, {
      headers: { Authorization: 'Bearer test-admin-token' }
    });
    assert.equal(allRes.status, 200);
    const allInvites = await allRes.json();
    assert.ok(allInvites.some((row) => row.email === 'second@example.com' && row.status === 'revoked'));
  } finally {
    await worker.dispose();
  }
}

test('auth invite lifecycle endpoints (integration)', { skip: !RUN_INTEGRATION }, async () => {
  await runIntegrationTests();
});

test('auth invite lifecycle integration is optional by default', { skip: RUN_INTEGRATION }, () => {
  assert.ok(
    true,
    'Set RUN_AUTH_INVITE_INTEGRATION=1 to run integration coverage for /auth/invites, /auth/invite/resend, and /auth/invite/revoke.'
  );
});
