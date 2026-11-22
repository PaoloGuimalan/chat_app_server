// Explicit disposable database only. No application credentials or migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { realmAccess, withActiveRealmWrite } = require('./realmAccess');
const connectionString = process.env.REALM_LIFECYCLE_TEST_DB_URL;
const schema = `realm_lifecycle_access_tests_${process.pid}`;
let pool;

async function setup() {
  if (!connectionString) return;
  const url = new URL(connectionString);
  assert.match(url.pathname, /^\/test_[a-z0-9_]+$/i, 'Only explicit test_* databases are allowed');
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
  await pool.query(`CREATE TABLE community_realm (
    id text PRIMARY KEY, realm_id text, entity_id text, slug text,
    parent_id text REFERENCES community_realm(id), is_active boolean NOT NULL DEFAULT TRUE,
    deletion_requested_at timestamptz, type text, is_private boolean DEFAULT FALSE
  )`);
  await pool.query(`INSERT INTO community_realm(id,realm_id) VALUES ('server','server')`);
  await pool.query(`INSERT INTO community_realm(id,realm_id,parent_id) VALUES ('channel','channel','server')`);
}

async function cleanup() {
  if (!pool) return;
  await pool.end();
  const admin = new Pool({ connectionString });
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}

test('PostgreSQL lifecycle lock ordering', { skip: !connectionString }, async (t) => {
  await setup();
  try {
  await t.test('post visibility hides deleting destinations and inactive page authors without hiding ordinary posts', async () => {
    const { postVisibleToSQL } = require('./posts');
    await pool.query(`CREATE TABLE entity_entity (id text PRIMARY KEY, type text);
      CREATE TABLE newsfeed_post (post_id text PRIMARY KEY, entity_id text, privacy_status text, on_feed text, approval integer);
      CREATE TABLE newsfeed_posttag (post_id text, entity_id text);
      CREATE TABLE community_member (realm_id text, entity_id text);
      CREATE TABLE newsfeed_postprivacy (post_id text, allowed_entity_id text);
      CREATE TABLE entity_connection (action_by_id text, involved_entity_id text, status boolean);
      INSERT INTO entity_entity VALUES ('user','user'),('community-entity','realm'),('page-entity','realm');
      INSERT INTO community_realm(id,realm_id,entity_id,type) VALUES ('community','community','community-entity','community'),('page','page','page-entity','page');
      INSERT INTO newsfeed_post VALUES ('ordinary','user','public','feed',1),('scoped','user','public','feed',1),('page-post','page-entity','public','feed',1);
      INSERT INTO newsfeed_posttag VALUES ('scoped','community-entity');`);
    const visible = async viewer => (await pool.query(`SELECT p.post_id FROM newsfeed_post p WHERE ${postVisibleToSQL('p', '$1')} ORDER BY p.post_id`, [viewer])).rows.map(row => row.post_id);
    assert.deepEqual(await visible('user'), ['ordinary', 'page-post', 'scoped']);
    await pool.query("UPDATE community_realm SET deletion_requested_at = NOW() WHERE id = 'community'");
    await pool.query("UPDATE community_realm SET is_active = FALSE WHERE id = 'page'");
    assert.deepEqual(await visible('user'), ['ordinary']);
    assert.deepEqual(await visible('page-entity'), ['ordinary']);
  });
  await t.test('queued community notices reject inactive page authors and deletion-marked destinations', async () => {
    const { createCommunityPostNotifier } = require('./communityPostNotifications');
    await pool.query(`CREATE TABLE user_account(entity_id text,username text);
      CREATE TABLE bot_bot(entity_id text,handle text);
      CREATE TABLE community_approvals(id uuid,realm_id text,target_kind text,target_id text,action text,content_version timestamptz,new_state jsonb);
      ALTER TABLE community_realm ADD COLUMN name text;
      ALTER TABLE newsfeed_post ADD COLUMN is_anonymous boolean DEFAULT FALSE;
      ALTER TABLE newsfeed_post ADD COLUMN is_archived boolean DEFAULT FALSE;
      ALTER TABLE newsfeed_post ADD COLUMN updated_at timestamptz;
      ALTER TABLE newsfeed_post ADD COLUMN deleted_at timestamptz;
      ALTER TABLE newsfeed_post ADD COLUMN date_posted timestamptz DEFAULT NOW();
      INSERT INTO newsfeed_posttag VALUES ('page-post','community-entity');
      UPDATE community_realm SET is_active=TRUE,deletion_requested_at=NULL;`);
    let writes = 0;
    const client = { query: (sql, args) => sql.includes('FROM community_member m JOIN entity_role')
      ? Promise.resolve({ rows: [] }) : pool.query(sql, args) };
    const notify = createCommunityPostNotifier({ client, notifications: { updateOne: async () => { writes++; } }, canManage: async () => false, publish: async () => {} });
    await notify('page-post');
    assert.equal(writes, 1);
    writes = 0;
    await pool.query("UPDATE community_realm SET is_active=FALSE WHERE id='page'");
    await notify('page-post');
    assert.equal(writes, 0, 'An inactive page author must not create inbox activity');
    await pool.query("UPDATE community_realm SET is_active=TRUE; UPDATE community_realm SET deletion_requested_at=NOW() WHERE id='community'");
    await notify('scoped');
    assert.equal(writes, 0, 'Deletion intent must stop new inbox records');
  });
  await t.test('real PostgreSQL hierarchy query blocks a child below an inactive server', async () => {
  await pool.query('UPDATE community_realm SET is_active = TRUE');
  assert.equal((await realmAccess(pool, 'channel')).allowed, true);
  await pool.query("UPDATE community_realm SET is_active = FALSE WHERE id = 'server'");
  assert.equal((await realmAccess(pool, 'channel')).reason, 'parent_inactive');
});

  await t.test('a lifecycle transaction wins against a waiting child writer', async () => {
  await pool.query('UPDATE community_realm SET is_active = TRUE');
  const lifecycle = await pool.connect();
  const writer = await pool.connect();
  try {
    await lifecycle.query('BEGIN');
    await lifecycle.query("SELECT id FROM community_realm WHERE id = 'server' FOR UPDATE");
    await lifecycle.query("UPDATE community_realm SET is_active = FALSE WHERE id = 'server'");
    let reachedLock;
    const locking = new Promise(resolve => { reachedLock = resolve; });
    const wrapped = { query(sql, params) {
      if (sql.includes('FOR SHARE')) reachedLock();
      return writer.query(sql, params);
    }, release() {} };
    let writes = 0;
    const write = withActiveRealmWrite({ connect: async () => wrapped }, ['channel'], async () => writes++);
    // Attach rejection handler before releasing the competing transaction.
    const denied = assert.rejects(write, /unavailable/i);
    await locking;
    await lifecycle.query('COMMIT');
    await denied;
    assert.equal(writes, 0);
  } finally {
    await lifecycle.query('ROLLBACK');
    lifecycle.release(); writer.release();
  }
});

  await t.test('an already authorized write finishes before server deactivation takes its lock', async () => {
  await pool.query('UPDATE community_realm SET is_active = TRUE');
  let releaseWrite, enteredWrite;
  const release = new Promise(resolve => { releaseWrite = resolve; });
  const entered = new Promise(resolve => { enteredWrite = resolve; });
  const order = [];
  const write = withActiveRealmWrite(pool, ['channel'], async () => {
    enteredWrite(); await release; order.push('write');
  });
  await entered;
  const lifecycle = await pool.connect();
  try {
    await lifecycle.query('BEGIN');
    const lock = lifecycle.query("SELECT id FROM community_realm WHERE id = 'server' FOR UPDATE");
    releaseWrite();
    await write;
    await lock;
    order.push('deactivate');
    await lifecycle.query("UPDATE community_realm SET is_active = FALSE WHERE id = 'server'");
    await lifecycle.query('COMMIT');
    assert.deepEqual(order, ['write', 'deactivate']);
    assert.equal((await realmAccess(pool, 'channel')).allowed, false);
  } finally { await lifecycle.query('ROLLBACK'); lifecycle.release(); }
});

  } finally { await cleanup(); }
});
