const test = require('node:test');
const assert = require('node:assert/strict');

test('multiple realm kinds are supported while child groups use channel applicability', () => {
  const { permissionApplies, effectiveRealmKind } = require('./permissionApplicability');
  const entry = { scope: 'realm', realm_types: ['page', 'server'] };
  for (const [type, expected] of [['page', true], ['server', true], ['community', false],
    ['group', false], ['conference', false], ['channel', false], ['voice', false]]) {
    assert.equal(permissionApplies(entry, { type }), expected);
  }
  assert.equal(effectiveRealmKind({ type: 'group', parent_id: 'parent' }), 'channel');
  assert.equal(permissionApplies({ scope: 'realm', realm_types: ['group'] }, { type: 'group', parent_id: 's' }), false);
  assert.equal(permissionApplies({ scope: 'realm', realm_types: ['channel'] }, { type: 'group', parent_id: 's' }), true);
});

test('malformed or absent realm applicability denies rather than granting a wildcard', () => {
  const { permissionApplies } = require('./permissionApplicability');
  for (const realm_types of [undefined, null, [], 'page', ['page', 'bogus'], [1], {}]) {
    assert.equal(permissionApplies({ scope: 'realm', realm_types }, { type: 'page' }), false);
  }
  assert.equal(permissionApplies({ scope: 'global' }, null), true);
  assert.equal(permissionApplies({ scope: 'entity_type' }, { type: 'community' }), true);
});
