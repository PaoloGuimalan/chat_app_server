const UserServer = require("../../schema/users/servers");
const UserGroups = require("../../schema/users/groups");
const dateGetter = require("../hooks/getDate");
const timeGetter = require("../hooks/getTime");
const makeid = require("../hooks/makeID");
const pool = require("../database/postgres");

const GetServerChannels = async (serverID, privacy) => {
  const { rows } = await pool.query(
    `SELECT 
    cr.realm_id AS _id, 
    cr.entity_id AS "entityID", 
    cr.parent_id AS "serverID",
    cr.realm_id AS "groupID",
    cr.name AS "groupName",
    cr.profile,
    json_build_object(
    'date', '',
    'time', ''
    ) AS dateCreated,
    pua.username AS "createdBy",
    cr.type AS type,
    cr.is_private AS privacy
    FROM community_realm cr
    LEFT JOIN user_account pua ON cr.created_by_id = pua.id
    WHERE cr.parent_id = $1 AND cr.type IN ('channel', 'voice') AND cr.is_private = $2;`,
    [serverID, privacy],
  );

  return rows;
};

const GetServerDetails = async (serverID) => {
  const { rows } = await pool.query(
    `SELECT 
    cr.realm_id AS _id, 
    cr.realm_id AS serverID,
    cr.name AS serverName,
    cr.profile,
    json_build_object(
    'date', '',
    'time', ''
    ) AS dateCreated,
    COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'userID', cm_username.username
              ))
              FROM community_member cm
              JOIN user_account cm_username ON cm.account_id = cm_username.id
              WHERE cm.realm_id = cr.realm_id
            ), '[]'::jsonb) AS members,
    pua.username AS createdBy,
    cr.is_private AS privacy
    FROM community_realm cr
    LEFT JOIN user_account pua ON cr.created_by_id = pua.id
    WHERE realm_id = $1 AND type = 'server';`,
    [serverID],
  );

  return rows.length > 0 ? rows[0] : null;

  //   return await UserServer.findOne({ serverID: serverID })
  //     .then((result) => {
  //       return result;
  //     })
  //     .catch((err) => {
  //       throw new Error(err);
  //     });
};

/**
 * Members of a realm/server. Entity-generic: community_member.entity_id can be
 * a person OR a page.
 *
 * entityID is taken from community_member itself, never from the joined detail
 * table. It used to be `pua.entity_id`, which is NULL for a realm member under
 * the LEFT JOIN - so a page member came back as a row with a null id, and
 * anything downstream (e.g. seeding a public channel with the server's members)
 * either skipped it or inserted a null. A realm's name/slug now fill the same
 * display fields a user's names do, matching how the rest of the stack maps
 * realms onto user-shaped keys.
 */
const GetServerMembers = async (serverID, withDetails) => {
  if (withDetails) {
    const { rows } = await pool.query(
      `SELECT
       COALESCE(pua.id, pr.id) AS _id,
       cr.entity_id AS "entityID",
       COALESCE(pua.id, pr.id) AS "userID",
       COALESCE(pua.username, pr.slug, pr.realm_id) AS username,
       CASE
        WHEN pr.id IS NOT NULL THEN json_build_object(
         'firstName', pr.name,
         'middleName', 'N/A',
         'lastName', ''
        )
        ELSE json_build_object(
         'firstName', pua.first_name,
         'middleName', pua.middle_name,
         'lastName', pua.last_name
        )
       END AS fullname,
       COALESCE(pua.profile, pr.profile, 'none') AS profile,
       COALESCE(pua.is_active, pr.is_active, TRUE) AS "isActivated",
       COALESCE(pua.is_verified, pr.is_verified, FALSE) AS "isVerified"
       FROM community_member cr
       LEFT JOIN user_account pua ON cr.entity_id = pua.entity_id
       LEFT JOIN community_realm pr ON cr.entity_id = pr.entity_id
       WHERE cr.realm_id = $1;`,
      [serverID],
    );

    return rows;
  } else {
    const { rows } = await pool.query(
      `SELECT
       COALESCE(pua.id, pr.id) AS _id,
       cr.entity_id AS "entityID",
       COALESCE(pua.id, pr.id) AS "userID",
       COALESCE(pua.username, pr.slug, pr.realm_id) AS username
       FROM community_member cr
       LEFT JOIN user_account pua ON cr.entity_id = pua.entity_id
       LEFT JOIN community_realm pr ON cr.entity_id = pr.entity_id
       WHERE cr.realm_id = $1;`,
      [serverID],
    );

    return rows;
  }
};

module.exports = {
  GetServerChannels,
  GetServerDetails,
  GetServerMembers,
};
