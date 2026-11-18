// Keep aligned with community/notification_permissions.py. Codes are server
// constants, never role display names or user-supplied SQL fragments.
const NOTICE_PERMISSIONS = Object.freeze({
  community_post_pending: ['realm.post.review'],
  community_invite_pending: ['realm.invite.review'],
  community_join_request: ['realm.notifications.view', 'realm.request.approve', 'realm.request.decline'],
});
const INBOX_TYPES = ['community_join_request', 'community_member_joined', 'community_post_created',
  'community_post_pending', 'community_invite_pending', 'post_comment', 'post_reaction', 'comment_reaction'];
const permissionsForNotice = type => NOTICE_PERMISSIONS[type] || ['realm.notifications.view'];
const MANAGEMENT_PERMISSIONS = [...new Set(INBOX_TYPES.flatMap(permissionsForNotice))];

function memberHasAnyPermissionSQL(member, role, codes = MANAGEMENT_PERMISSIONS) {
  if (![member, role].every(value => /^[a-z_][a-z0-9_]*$/i.test(value)) ||
      !codes.length || codes.some(code => !MANAGEMENT_PERMISSIONS.includes(code))) throw new TypeError('Invalid management capability query');
  return `(${role}.realm_id = ${member}.realm_id AND EXISTS (
    SELECT 1 FROM entity_permission_catalog notice_cap
    WHERE notice_cap.scope = 'realm' AND notice_cap.is_active = TRUE
      AND notice_cap.code IN (${codes.map(code => `'${code}'`).join(',')})
      AND ((${role}.code = 'owner' AND ${role}.is_default = TRUE) OR COALESCE((
        SELECT notice_override.effect = 'grant' FROM entity_permission notice_override
        WHERE notice_override.entity_id = ${member}.entity_id AND notice_override.realm_id = ${member}.realm_id
          AND notice_override.permission_id = notice_cap.id
          AND (notice_override.expires_at IS NULL OR notice_override.expires_at > NOW()) LIMIT 1
      ), EXISTS (SELECT 1 FROM entity_role_permissions notice_grant
        WHERE notice_grant.role_id = ${role}.id AND notice_grant.permission_id = notice_cap.id)))
  ))`;
}

function managementNoticeTypesSQL(member, role) {
  return `ARRAY_REMOVE(ARRAY[${INBOX_TYPES.map(kind =>
    `CASE WHEN ${memberHasAnyPermissionSQL(member, role, permissionsForNotice(kind))} THEN '${kind}' END`).join(',')}], NULL)`;
}

module.exports = { INBOX_TYPES, MANAGEMENT_PERMISSIONS, memberHasAnyPermissionSQL, managementNoticeTypesSQL };
