function capitalizeFirstLetter(string) {
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

  const output = {
    fullname: {
      firstName: input.first_name,
      middleName: input.middle_name,
      lastName: input.last_name,
    },
    birthdate: {
      month: monthNames[birthDate.getMonth()],
      day: birthDate.getDate().toString(),
      year: birthDate.getFullYear().toString(),
    },
    dateCreated: {
      date: formatDate(dateCreated),
      time: formatTime(dateCreated).toLowerCase(),
    },
    _id: input.id,
    userID: input.username,
    profile: input.profile === "N/A" ? "none" : input.profile,
    gender: capitalizeFirstLetter(input.gender),
    email: input.email,
    password: null,
    isActivated: !!input.is_active,
    isVerified: !!input.is_verified,
  };

  return output;
}

module.exports = {
  transformUser,
};
