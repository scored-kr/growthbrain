import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const sql = new URL('../../scripts/proposed/account-sync-v1.sql', import.meta.url);
const models = {
  growthbrain_sync_v1_status: [],
  growthbrain_sync_v1_read: [],
  growthbrain_sync_v1_write: ['expected_revision','payload'],
  growthbrain_sync_v1_purge: ['expected_revision'],
};

// Disposable PostgreSQL, no Supabase keys/network. The HTTP test boundary supplies
// an already verified account. Each SQL call runs with that identity and role.
export async function createSyncRpcFixture() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;`);
    await db.exec(await readFile(sql, 'utf8'));
  } catch (error) { await db.close(); throw error; }
  return {
    async rpc(accountId, name, args = {}) {
      const keys = Object.hasOwn(models, name) && models[name];
      if (!keys || Object.keys(args).length !== keys.length || !keys.every(k => Object.hasOwn(args, k))) {
        return {status:404, body:{code:'PGRST202'}};
      }
      try {
        const body = await db.transaction(async tx => {
          if (accountId) {
            await tx.query('insert into auth.users(id) values($1) on conflict do nothing', [accountId]);
            await tx.exec('set local role authenticated');
            await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [accountId]);
          } else {
            await tx.exec('set local role anon');
          }
          const params = keys.map(k => k === 'payload' ? JSON.stringify(args[k]) : args[k]);
          const result = await tx.query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) as body`, params);
          return result.rows[0].body;
        });
        return {status:200, body};
      } catch (error) {
        const status = {PT409:409,PT400:400,PT413:413,'42501':403,'22P02':400}[error.code] ?? 500;
        if (status === 500) throw error;
        return {status, body:{code:error.code}};
      }
    },
    inspect: async () => (await db.query('select * from growthbrain_sync_v1_private.snapshots order by owner_id')).rows,
    // Only for explicit SQL privilege checks / synthetic admin quota fixtures.
    db,
    close: () => db.close(),
  };
}
