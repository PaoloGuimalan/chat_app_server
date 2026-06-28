const pool = require("../../reusables/database/postgres");

const buildEntityID = (entityType, sourceID) =>
  `entity:${String(entityType).trim().toLowerCase()}:${String(sourceID).trim()}`;

const buildUserEntityID = (userID) => buildEntityID("user", userID);
const buildRealmEntityID = (realmID) => buildEntityID("realm", realmID);

const normalizeEntityID = (entityID) => {
  if (entityID === null || entityID === undefined) return null;
  const normalized = String(entityID).trim();
  if (!normalized || !normalized.startsWith("entity:")) return null;
  return normalized;
};

const parseEntityID = (entityID) => {
  const normalized = normalizeEntityID(entityID);
  if (!normalized) return null;

  const parts = normalized.split(":");
  if (parts.length < 3) return null;

  return {
    entityType: parts[1],
    sourceID: parts.slice(2).join(":"),
  };
};

const normalizeEntityList = (entityIDs = []) => {
  return [
    ...new Set(
      (entityIDs || [])
        .map((entry) => {
          if (!entry) return null;
          if (typeof entry === "string") {
            return normalizeEntityID(entry);
          }

          const candidate =
            entry.entity_id || entry.entityID || entry.id || entry.entityId;
          return normalizeEntityID(candidate);
        })
        .filter(Boolean),
    ),
  ];
};

const getEntityByEntityID = async (entityID) => {
  const normalized = normalizeEntityID(entityID);
  if (!normalized) return null;

  const { rows } = await pool.query(
    `
      SELECT *
      FROM entity
      WHERE entity_id = $1
      LIMIT 1;
    `,
    [normalized],
  );

  return rows[0] || null;
};

const buildFallbackEntity = (entityID) => {
  const parsed = parseEntityID(entityID);
  if (!parsed) return null;

  return {
    id: null,
    entity_id: normalizeEntityID(entityID),
    entity_type: parsed.entityType,
    source_id: parsed.sourceID,
    source_type:
      parsed.entityType === "user"
        ? "user.account"
        : parsed.entityType === "realm"
          ? "community.realm"
          : "unknown",
  };
};

const resolveUserEntity = async (userID) => {
  const { rows } = await pool.query(
    `
      SELECT *
      FROM entity
      WHERE entity_type = 'user'
        AND source_id = $1
      ORDER BY updated_at DESC
      LIMIT 1;
    `,
    [userID],
  );

  if (rows.length > 0) {
    return rows[0];
  }

  return {
    id: null,
    entity_id: buildUserEntityID(userID),
    entity_type: "user",
    source_type: "user.account",
    source_id: userID,
  };
};

const canUserActAsEntity = async ({ userID, entityID }) => {
  const normalizedEntityID = normalizeEntityID(entityID);
  if (!normalizedEntityID) return false;

  const parsedEntity = parseEntityID(normalizedEntityID);
  const targetEntity =
    (await getEntityByEntityID(normalizedEntityID)) ||
    buildFallbackEntity(normalizedEntityID);
  if (!targetEntity || !parsedEntity) return false;

  if (
    parsedEntity.entityType === "user" &&
    String(parsedEntity.sourceID) === String(userID)
  ) {
    return true;
  }

  if (parsedEntity.entityType !== "realm" || !parsedEntity.sourceID) {
    return false;
  }

  const userEntity = await resolveUserEntity(userID).catch(() => null);
  if (!userEntity?.id) {
    return false;
  }
  const actorAccountIDs = [String(userEntity.id)];

  const { rows } = await pool.query(
    `
      SELECT 1
      FROM community_member
      WHERE account_id = ANY($1::text[])
        AND realm_id = $2
        AND role = 'admin'
      LIMIT 1;
    `,
    [actorAccountIDs, parsedEntity.sourceID],
  );

  return rows.length > 0;
};

const resolveActingEntity = async ({ userID, entityID = null }) => {
  const userEntity = await resolveUserEntity(userID);
  const requestedEntityID = normalizeEntityID(entityID);

  if (!requestedEntityID || requestedEntityID === userEntity.entity_id) {
    return {
      entityID: userEntity.entity_id,
      senderType: "user",
      authorRealm: null,
      actorUserID: userID,
      entity: userEntity,
    };
  }

  const parsedEntity = parseEntityID(requestedEntityID);
  if (!parsedEntity) throw new Error("Invalid sender entity");

  const targetEntity =
    (await getEntityByEntityID(requestedEntityID)) ||
    buildFallbackEntity(requestedEntityID);

  const allowed = await canUserActAsEntity({ userID, entityID: requestedEntityID });
  if (!allowed) {
    throw new Error("You are not allowed to act as this entity");
  }

  return {
    entityID: requestedEntityID,
    senderType:
      parsedEntity.entityType === "realm"
        ? "realm"
        : parsedEntity.entityType === "bot"
          ? "bot"
          : "user",
    authorRealm:
      parsedEntity.entityType === "realm" ? parsedEntity.sourceID : null,
    actorUserID: userID,
    entity: targetEntity,
  };
};

const expandMemberTargets = async ({
  memberUserIDs = [],
  memberEntityIDs = [],
}) => {
  const expandedMap = new Map();

  (memberUserIDs || []).filter(Boolean).forEach((userID) => {
    expandedMap.set(String(userID), {
      userID: String(userID),
      joinedAsEntityID: null,
    });
  });

  const normalizedEntityIDs = normalizeEntityList(memberEntityIDs);
  if (normalizedEntityIDs.length === 0) {
    return Array.from(expandedMap.values());
  }

  const parsedEntities = normalizedEntityIDs.map((entityID) => ({
    entityID,
    parsed: parseEntityID(entityID),
  }));

  parsedEntities.forEach(({ entityID, parsed }) => {
    if (!parsed) return;
    if (parsed.entityType !== "user") return;

    expandedMap.set(String(parsed.sourceID), {
      userID: String(parsed.sourceID),
      joinedAsEntityID: entityID,
    });
  });

  const parsedRealmEntities = parsedEntities.filter(
    ({ parsed }) => parsed && parsed.entityType === "realm" && parsed.sourceID,
  );

  if (parsedRealmEntities.length > 0) {
    const realmIDs = [
      ...new Set(parsedRealmEntities.map(({ parsed }) => String(parsed.sourceID))),
    ];
    const realmEntityByRealmID = new Map(
      parsedRealmEntities.map(({ entityID, parsed }) => [
        String(parsed.sourceID),
        entityID,
      ]),
    );

    const { rows: delegatedMembers } = await pool.query(
      `
        SELECT
          realm_id,
          COALESCE(account_entity.source_id, cm.account_id) AS user_id
        FROM community_member cm
        LEFT JOIN entity account_entity
          ON cm.account_id = account_entity.id
         AND account_entity.entity_type = 'user'
        WHERE realm_id = ANY($1::text[])
          AND role = 'admin';
      `,
      [realmIDs],
    );

    delegatedMembers.forEach((member) => {
      if (!member.user_id) return;
      const targetEntityID = realmEntityByRealmID.get(String(member.realm_id));
      if (!targetEntityID) return;
      expandedMap.set(String(member.user_id), {
        userID: String(member.user_id),
        joinedAsEntityID: targetEntityID,
      });
    });
  }

  return Array.from(expandedMap.values());
};

const userIDsToEntityIDs = (userIDs = []) => {
  return [
    ...new Set(
      (userIDs || [])
        .filter(Boolean)
        .map((userID) => buildUserEntityID(userID)),
    ),
  ];
};

const getRealmIDsViaActingEntities = async (userID) => {
  const userEntity = await resolveUserEntity(userID).catch(() => null);
  if (!userEntity?.id) {
    return [];
  }
  const actorAccountIDs = [String(userEntity.id)];

  const { rows } = await pool.query(
    `
      SELECT DISTINCT cm_target.realm_id
      FROM community_member cm_target
      JOIN community_member cm_actor
        ON cm_actor.realm_id = REPLACE(cm_target.nickname, 'entity:realm:', '')
       AND cm_actor.account_id = ANY($1::text[])
       AND cm_actor.role = 'admin'
      WHERE cm_target.nickname IS NOT NULL
        AND cm_target.nickname LIKE 'entity:realm:%';
    `,
    [actorAccountIDs],
  );

  return rows.map((row) => row.realm_id).filter(Boolean);
};

module.exports = {
  buildEntityID,
  buildUserEntityID,
  buildRealmEntityID,
  normalizeEntityID,
  parseEntityID,
  normalizeEntityList,
  getEntityByEntityID,
  resolveUserEntity,
  canUserActAsEntity,
  resolveActingEntity,
  expandMemberTargets,
  userIDsToEntityIDs,
  getRealmIDsViaActingEntities,
};
