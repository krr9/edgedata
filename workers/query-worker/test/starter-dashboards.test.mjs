import test from 'node:test';
import assert from 'node:assert/strict';

import { seedStarterDashboards } from '../src/starter-dashboards.mjs';

function createFakeDb() {
  const inserts = [];

  return {
    inserts,
    prepare(sql) {
      const statement = {
        async first() {
          if (sql.includes('WHERE is_default = 1') && sql.includes('name = ?')) return null;
          if (sql.includes('COUNT(*) as cnt')) return { cnt: 0 };
          return null;
        },
        async run() {
          inserts.push({ sql, args: [] });
          return { success: true };
        },
        bind(...args) {
          return {
            async first() {
              if (sql.includes('WHERE is_default = 1') && sql.includes('name = ?')) return null;
              if (sql.includes('COUNT(*) as cnt')) return { cnt: 0 };
              return null;
            },
            async run() {
              inserts.push({ sql, args });
              return { success: true };
            }
          };
        }
      };
      return statement;
    }
  };
}

test('seedStarterDashboards assigns cached starter dashboard execution defaults', async () => {
  const db = createFakeDb();

  const result = await seedStarterDashboards(db);

  assert.equal(result.seeded, true);

  const dashboardInsert = db.inserts.find((entry) => entry.sql.includes('INSERT INTO dashboards'));
  assert.ok(dashboardInsert);
  assert.equal(dashboardInsert.args[3], 'cached');

  const panelInsert = db.inserts.find((entry) => entry.sql.includes('INSERT INTO dashboard_panels'));
  assert.ok(panelInsert);
  assert.equal(panelInsert.args[6], 'cached');
  assert.equal(panelInsert.args[7], 300);
  assert.equal(panelInsert.args[8], 1);
  assert.equal(panelInsert.args[9], 300);
  assert.equal(panelInsert.args[10], 900);
});
