const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCommunityPostApproval } = require('./communityPublication');

test('community publication follows fresh realm grants without environment opt-in', async () => {
  const client = {};
  const grants = new Set(['posts.create', 'realm.post.submit', 'realm.post.publish']);
  const options = { checkPermission: async (actor, code, realm, context) => {
    assert.equal(actor, 'author');
    assert.equal(realm, code === 'posts.create' ? null : 'club');
    assert.equal(context.client, client);
    assert.equal(context.fresh, true);
    return grants.has(code);
  }};
  assert.equal(await resolveCommunityPostApproval(client, 'author', null, options), 1);
  assert.equal(await resolveCommunityPostApproval(client, 'author', { realm_id: 'club' }, options), 1);
  grants.delete('realm.post.publish');
  assert.equal(await resolveCommunityPostApproval(client, 'author', { realm_id: 'club' }, options), 0);
  grants.delete('realm.post.submit');
  await assert.rejects(resolveCommunityPostApproval(client, 'author', { realm_id: 'club' }, options), { status: 403 });
});
