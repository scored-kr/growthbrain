import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql=await readFile(new URL('../scripts/inspect-supabase-schema.sql',import.meta.url),'utf8');
// Execute the exact SQL branches; only psql's \gset / \if control is emulated.
const catalogSQL=sql.slice(0,sql.indexOf('SELECT to_regclass'));
const migrationSQL=sql.split('\\if :migration_table_exists\n')[1].split('\\else\n')[0].trim();
const absentSQL=sql.split('\\else\n')[1].split('\\endif')[0].trim();
async function inspect(db){
 const results=await db.exec(catalogSQL),catalog=results.at(-1).rows[0].json_build_object;
 const exists=(await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present")).rows[0].present;
 const migration=(await db.query(exists?migrationSQL:absentSQL)).rows[0];
 await db.exec('ROLLBACK;');
 return {catalog,migration:Object.values(migration)[0]};
}
test('the inspector SQL runs against PostgreSQL WASM catalogs and observes policies without reading application rows',async()=>{
 const db=new PGlite();
 try{
  await db.exec("CREATE TABLE vault_blobs(id int primary key,user_id uuid,ciphertext bytea); INSERT INTO vault_blobs VALUES (1,'11111111-1111-4111-8111-111111111111',decode('deadbeef','hex'));");
  let result=await inspect(db);
  assert.equal(result.catalog.readOnly,true);assert.equal(result.catalog.database,'postgres');
  assert.equal(result.catalog.tables[0].rlsEnabled,false);assert.equal(result.migration.present,null);
  await db.exec("ALTER TABLE vault_blobs ENABLE ROW LEVEL SECURITY; CREATE POLICY owner_only ON vault_blobs USING (user_id = '11111111-1111-4111-8111-111111111111'); CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text primary key); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261102050001');");
  result=await inspect(db);assert.equal(result.catalog.tables[0].rlsEnabled,true);
  assert.equal(result.catalog.tables[0].policies[0].name,'owner_only');assert.equal(result.migration.present,false);
  assert.ok(!JSON.stringify(result).includes('deadbeef'),'Only metadata, no ciphertext or memory rows');
  await db.exec("INSERT INTO supabase_migrations.schema_migrations VALUES ('20261102050000')");
  assert.equal((await inspect(db)).migration.present,true);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM vault_blobs')).rows[0].count,1);
 }finally{await db.close();}
});
test('PostgreSQL enforces read-only transactions against accidental INSERT and DROP during inspection',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE TABLE vault_blobs(id int primary key); INSERT INTO vault_blobs VALUES(1);');
  for(const statement of ['INSERT INTO public.vault_blobs VALUES(2)','DROP TABLE public.vault_blobs']){
   await db.exec(catalogSQL);
   await assert.rejects(db.exec(statement),/read.only transaction/i);
   await db.exec('ROLLBACK;');
   assert.equal((await db.query('SELECT count(*)::int AS count FROM vault_blobs')).rows[0].count,1);
  }
 }finally{await db.close();}
});
