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
    cr.parent_id AS serverID,
    cr.realm_id AS groupID,
    cr.name AS groupName,
    cr.profile,
    json_build_object(
    'date', '',
    'time', ''
    ) AS dateCreated,
    pua.username AS createdBy,
    'server' AS type,
    cr.is_private AS privacy
    FROM community_realm cr
    LEFT JOIN user_account pua ON cr.created_by_id = pua.id
    WHERE cr.parent_id = $1 AND cr.type = 'group' AND cr.is_private = $2;`,
    [serverID, privacy]
  );

  return rows;

  //   return await UserGroups.find({
  //     serverID: serverID,
  //     privacy: privacy,
  //     type: "server",
  //   })
  //     .then((result) => {
  //       return result;
  //     })
  //     .catch((err) => {
  //       throw new Error(err);
  //     });
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
    [serverID]
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
       pua.username AS 'userID',
       pua.username AS username,
       json_build_object(
        'firstName', pua.first_name,
        'middleName', pua.middle_name,
        'lastName', pua.last_name
       ) AS fullname,
       pua.profile,
       pua.is_active AS 'isActivated',
       pua.is_verified AS 'isVerified'
       FROM community_member cr
       LEFT JOIN user_account pua ON cr.account_id = pua.id
       WHERE realm_id = $1;`,
      [serverID]
    );

    return rows;

    // return await UserServer.aggregate([
    //   {
    //     $match: { serverID: serverID },
    //   },
    //   {
    //     $lookup: {
    //       from: "useraccount",
    //       localField: "members.userID",
    //       foreignField: "userID",
    //       as: "userdetails",
    //     },
    //   },
    //   {
    //     $project: {
    //       "userdetails.birthdate": 0,
    //       "userdetails.dateCreated": 0,
    //       "userdetails.email": 0,
    //       "userdetails.gender": 0,
    //       "userdetails.password": 0,
    //       "userdetails.coverphoto": 0,
    //     },
    //   },
    // ])
    //   .then((result) => {
    //     if (result.length > 0) {
    //       return result[0].userdetails;
    //     } else {
    //       return null;
    //     }
    //   })
    //   .catch((err) => {
    //     throw new Error(err);
    //   });
  } else {
    const { rows } = await pool.query(
      `SELECT
       pua.id AS _id,
       pua.username AS userID,
       pua.username AS username
       FROM community_member cr
       LEFT JOIN user_account pua ON cr.account_id = pua.id
       WHERE realm_id = $1;`,
      [serverID]
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
