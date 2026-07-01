function capitalizeFirstLetter(string) {
  if (string === null) return null;
  if (!string || typeof string !== "string") return "";
  return string.charAt(0).toUpperCase() + string.slice(1).toLowerCase();
}

function transformUser(input) {
  const birthDate = new Date(input.birthdate);
  const dateCreated = new Date(input.date_created);

  // Helper to get month name from number
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // Format time in hh:mm:ss am/pm
  function formatTime(date) {
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const ampm = hours >= 12 ? "pm" : "am";
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 => 12
    const strMinutes = minutes < 10 ? "0" + minutes : minutes;
    const strSeconds = seconds < 10 ? "0" + seconds : seconds;
    return `${hours}:${strMinutes}:${strSeconds} ${ampm}`;
  }

  // Format date as MM/DD/YYYY
  function formatDate(date) {
    const mm = (date.getMonth() + 1).toString().padStart(2, "0");
    const dd = date.getDate().toString().padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  const profileRequirements = ["birthdate", "gender"];
  const isComplete = profileRequirements.every((field) => input[field]);

  const output = {
    fullname: {
      firstName: input.first_name,
      middleName: input.middle_name,
      lastName: input.last_name,
    },
    birthdate: input.birthdate
      ? {
          month: monthNames[birthDate.getMonth()],
          day: birthDate.getDate().toString(),
          year: birthDate.getFullYear().toString(),
        }
      : null,
    dateCreated: {
      date: formatDate(dateCreated),
      time: formatTime(dateCreated).toLowerCase(),
    },
    _id: input.id,
    userID: input.username,
    profile: input.profile === "N/A" ? "none" : input.profile,
    coverphoto: input.coverphoto,
    gender: input.gender ? capitalizeFirstLetter(input.gender) : null,
    email: input.email,
    password: null,
    isActivated: !!input.is_active,
    isVerified: !!input.is_verified,
    isComplete: isComplete,
  };

  return output;
}

function generateUUID() {
  let dt = new Date().getTime();
  let dt2 =
    (typeof performance !== "undefined" &&
      performance.now &&
      performance.now() * 1000) ||
    0;

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    let r = Math.random() * 16;

    if (dt > 0) {
      r = ((dt + r) % 16) | 0;
      dt = Math.floor(dt / 16);
    } else {
      r = ((dt2 + r) % 16) | 0;
      dt2 = Math.floor(dt2 / 16);
    }

    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function formatConnectionData(rows) {
  if (!rows.length) return null;

  const connection = {
    _id: rows[0].connection_id, // assuming connection_id is unique for this group
    contactID: rows[0].connection_id,
    actionBy: rows[0].username, // actionBy is from one "action_by_id" user, adjust if needed
    actionDate: {
      date: new Date(rows[0].action_date).toLocaleDateString("en-US"),
      time: new Date(rows[0].action_date).toLocaleTimeString("en-US", {
        hour12: true,
      }),
    },
    status: rows[0].status,
    type: rows[0].type,
    users: [],
    usersWithInfo: [],
  };

  // Create a map to avoid duplication
  const userIds = new Set();

  rows.forEach((row) => {
    // Add to users array
    if (!userIds.has(row.username)) {
      userIds.add(row.username);
      connection.users.push({
        userID: row.username,
        _id: row.involved_user_id,
      });

      connection.usersWithInfo.push({
        _id: row.involved_user_id,
        entityID: row.entity_id,
        userID: row.username,
        fullname: {
          firstName: row.first_name,
          middleName: row.middle_name,
          lastName: row.last_name,
        },
        profile: row.profile,
        isActivated: row.is_active,
        isVerified: row.is_verified,
      });
    }
  });

  return connection;
}

function formatToDesiredStructure(input) {
  const data = {
    _id: input.id,
    contactID: input.realm_id,
    actionBy: input.usersWithInfo[0]?.userID || null, // Or supply correctly
    actionDate: {
      date: "", // supply real date if available
      time: "", // supply real time if available
    },
    is_admin: input.is_admin,
    is_member: input.is_member,
    status: true, // supply real value if available
    type: input.type, // supply real value if available
    users: input.usersWithInfo.map((u) => ({
      userID: u.userID,
      _id: u._id, // replace with correct mongo _id if different
    })),
    conversationInfo: {
      _id: input.realm_id, // supply actual conversation id
      serverID: input.parent_id,
      groupID: input.realm_id,
      groupName: input.name,
      profile: input.profile,
      starts_at: input.starts_at ?? null,
      expires_at: input.expires_at ?? null,
      is_temporary: input.is_temporary ?? null,
      created_at: input.created_at ?? null,
      dateCreated: {
        date: "", // supply real date
        time: "", // supply real time
      },
      createdBy: input.usersWithInfo[0]?.userID || null,
      type: input.type, // supply real type
      privacy: input.privacy, // supply real privacy
    },
    usersWithInfo: input.usersWithInfo.map((u) => ({
      _id: u._id,
      entityID: u.entityID,
      userID: u.userID,
      fullname: u.fullname,
      profile: u.profile,
      isActivated: u.isActivated,
      isVerified: u.isVerified,
    })),
    conversationfiles: [],
  };

  return data;
}

function transformServersData(serversArray, preview) {
  return serversArray.map((input) => {
    // const now = new Date();
    return {
      dateCreated: {
        date: "", // now.toLocaleDateString("en-US")
        time: "", //now.toLocaleTimeString("en-US", { hour12: true })
      },
      _id: input.id,
      serverID: input.realm_id,
      serverName: input.name,
      profile: input.profile == "N/A" ? "" : input.profile,
      members: preview ? [] : input.members.map((m) => ({ userID: m.userID })),
      member_count: parseInt(input.member_count) ?? 0,
      is_joined: input.is_joined,
      createdBy: input.created_by_id,
      privacy: input.is_private,
      cover_photo: input.cover_photo,
      description: input.description,
    };
  });
}

function sanitizeForStorage(content) {
  if (!content) return "";
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractMentionUsernames(text = "") {
  const matches = [
    ...text.matchAll(/(?:^|\s)@([A-Za-z0-9._-]{1,30})(?=$|\s|[.,!?;:])/g),
  ];
  return [...new Set(matches.map((m) => m[1]))];
}

module.exports = {
  transformUser,
  generateUUID,
  formatConnectionData,
  formatToDesiredStructure,
  transformServersData,
  sanitizeForStorage,
  extractMentionUsernames,
};
