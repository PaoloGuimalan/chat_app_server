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
    LEFT JOIN entity created_by_entity
      ON cr.created_by_id = created_by_entity.id
     AND created_by_entity.entity_type = 'user'
    LEFT JOIN user_account pua ON created_by_entity.source_id = pua.id
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
              LEFT JOIN entity cm_entity
                ON cm.account_id = cm_entity.id
               AND cm_entity.entity_type = 'user'
              JOIN user_account cm_username
                ON COALESCE(cm_entity.source_id, cm.account_id) = cm_username.id
              WHERE cm.realm_id = cr.realm_id
            ), '[]'::jsonb) AS members,
    pua.username AS createdBy,
    cr.is_private AS privacy
    FROM community_realm cr
    LEFT JOIN entity created_by_entity
      ON cr.created_by_id = created_by_entity.id
     AND created_by_entity.entity_type = 'user'
    LEFT JOIN user_account pua ON created_by_entity.source_id = pua.id
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

const GetServerMembers = async (serverID, withDetails) => {
  if (withDetails) {
    const { rows } = await pool.query(
      `SELECT
       pua.id AS _id,
       pua.id AS "userID",
       pua.username AS username,
       json_build_object(
        'firstName', pua.first_name,
        'middleName', pua.middle_name,
        'lastName', pua.last_name
       ) AS fullname,
       pua.profile,
       pua.is_active AS "isActivated",
       pua.is_verified AS "isVerified"
       FROM community_member cr
       LEFT JOIN entity member_entity
         ON cr.account_id = member_entity.id
        AND member_entity.entity_type = 'user'
       LEFT JOIN user_account pua
         ON COALESCE(member_entity.source_id, cr.account_id) = pua.id
       WHERE realm_id = $1;`,
      [serverID],
    );

    return rows;
  } else {
    const { rows } = await pool.query(
      `SELECT
       pua.id AS _id,
       pua.id AS "userID",
       pua.username AS username
       FROM community_member cr
       LEFT JOIN entity member_entity
         ON cr.account_id = member_entity.id
        AND member_entity.entity_type = 'user'
       LEFT JOIN user_account pua
         ON COALESCE(member_entity.source_id, cr.account_id) = pua.id
       WHERE realm_id = $1;`,
      [serverID],
    );

    return rows;
    // return await UserServer.findOne({ serverID: serverID })
    //   .then((result) => {
    //     return result.members;
    //   })
    //   .catch((err) => {
    //     throw new Error(err);
    //   });
  }
};

module.exports = {
  GetServerChannels,
  GetServerDetails,
  GetServerMembers,
};
