/** Evaluate inside the same transaction/realm locks as destination validation. */
async function resolveCommunityPostApproval(client, actorID, community, options = {}) {
  if (!community) return 1;
  const check = options.checkPermission ?? require('../hooks/permissionChecker').hasActivePermission;
  const enabled = options.enabled ?? require('../vars/config').communityApprovalsEnabled;
  const context = { client, fresh: true };
  if (!(await check(actorID, 'posts.create', null, context))) {
    throw Object.assign(new Error('You cannot publish posts right now.'), { status: 403, publicMessage: 'You cannot publish posts right now.' });
  }
  if (!(await check(actorID, 'realm.post.submit', community.realm_id, context))) {
    throw Object.assign(new Error('You cannot submit posts in this community.'), { status: 403, publicMessage: 'You cannot submit posts in this community.' });
  }
  if (await check(actorID, 'realm.post.publish', community.realm_id, context)) return 1;
  if (!enabled) {
    throw Object.assign(new Error('Posts requiring review are not available yet.'), { status: 403, publicMessage: 'Posts requiring review are not available yet.' });
  }
  return 0;
}

module.exports = { resolveCommunityPostApproval };
