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

const GetServerMembers = async (serverID, withDetails) => {
    if(withDetails){
        return await UserServer.aggregate([
            {
                $match: { serverID: serverID}
            },
            {
                $lookup: {
                    from: "useraccount",
                    localField: "members.userID",
                    foreignField: "userID",
                    as: "userdetails"
                }
            },
            {
                $project: {
                    "userdetails.birthdate": 0,
                    "userdetails.dateCreated": 0,
                    "userdetails.email": 0,
                    "userdetails.gender": 0,
                    "userdetails.password": 0,
                    "userdetails.coverphoto": 0
                }
            }
        ]).then((result) => {
            if(result.length > 0){
                return result[0].userdetails;
            }
            else{
                return null;
            }
        }).catch((err) => {
            throw new Error(err);
        })
    }
    else{
        return await UserServer.findOne({ serverID: serverID}).then((result) => {
            return result.members;
        }).catch((err) => {
            throw new Error(err);
        })
    }
}

module.exports = {
    GetServerChannels,
    GetServerDetails,
    GetServerMembers
}