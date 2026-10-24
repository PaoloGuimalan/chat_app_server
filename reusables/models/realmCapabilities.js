const canUseMessaging = (realmType) => realmType !== "community";

// Accept realm IDs, entity IDs and slugs: message routes support all three.
// Keeping this lookup independent of membership prevents community owners from
// accidentally acquiring conversation capabilities through their management role.
const assertMessagingTarget = async (client, ...identifiers) => {
  const ids = identifiers.filter(Boolean).map(String);
  if (!ids.length) return;

  const { rows } = await client.query(
    `SELECT type FROM community_realm
     WHERE type = 'community'
       AND (realm_id = ANY($1::text[]) OR entity_id = ANY($1::text[]) OR slug = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM entity_connection c
           WHERE c.connection_id = ANY($1::text[])
             AND (c.action_by_id = community_realm.entity_id OR c.involved_entity_id = community_realm.entity_id)))
     LIMIT 1`,
    [ids],
  );
  if (rows.some((realm) => !canUseMessaging(realm.type))) {
    throw Object.assign(new Error("Communities do not support messaging"), { status: 403 });
  }
};

module.exports = { assertMessagingTarget, canUseMessaging };
