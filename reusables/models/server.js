const UserServer = require("../../schema/users/servers");
const UserGroups = require("../../schema/users/groups")
const dateGetter = require("../hooks/getDate");
const timeGetter = require("../hooks/getTime");
const makeid = require("../hooks/makeID");

const GetServerChannels = async (serverID, privacy) => {
    return await UserGroups.find({ serverID: serverID, privacy: privacy, type: "server" }).then((result) => {
        return result;
    }).catch((err) => {
        throw new Error(err);
    })
}

const GetServerDetails = async (serverID) => {
    return await UserServer.findOne({ serverID: serverID}).then((result) => {
        return result;
    }).catch((err) => {
        throw new Error(err);
    })
}

const GetServerMembers = async (serverID) => {
    return await UserServer.findOne({ serverID: serverID}).then((result) => {
        return result.members;
    }).catch((err) => {
        throw new Error(err);
    })
}

module.exports = {
    GetServerChannels,
    GetServerDetails,
    GetServerMembers
}