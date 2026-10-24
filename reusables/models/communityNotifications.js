// Community activity uses the community entity as its stored sender, including
// identified contributions. This allows audience checks before Mongo pagination
// without storing the real identity of an anonymous contributor in Mongo.
const notificationAudienceMatch = async (client, match, viewerID) => {
  const { rows } = await client.query(
    `SELECT r.entity_id FROM community_realm r
     WHERE r.type = 'community'
       AND (r.is_active = FALSE OR (r.is_private = TRUE AND NOT EXISTS (
         SELECT 1 FROM community_member m
         WHERE m.realm_id = r.id AND m.entity_id = $1
       )))`,
    [viewerID],
  );
  if (!rows.length) return match;
  return {
    $and: [match, { fromUserID: { $nin: rows.map((row) => row.entity_id) } }],
  };
};

const authorizedNotificationStream = (response, authorize) => ({
  async sse(event, payload) {
    const target = payload?.result;
    if (target?.community_entity_id && target?.post_id) {
      try {
        if (!(await authorize(target.post_id))) return;
      } catch {
        return;
      }
    }
    response.sse(event, payload);
  },
});

module.exports = { notificationAudienceMatch, authorizedNotificationStream };
