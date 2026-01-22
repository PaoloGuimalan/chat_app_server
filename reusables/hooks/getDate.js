const formatToDjangoDate = (date) => {
  if (!date) return null;

  // Get user's ACTUAL timezone offset (e.g., +0800 for PST)
  const offsetMs = date.getTimezoneOffset() * 60000;
  const offsetHours = Math.floor(Math.abs(offsetMs) / 3600000);
  const offsetMinutes = Math.floor((Math.abs(offsetMs) % 3600000) / 60000);
  const sign = offsetMs <= 0 ? "+" : "-";
  const offsetStr = `${sign}${offsetHours.toString().padStart(2, "0")}${offsetMinutes.toString().padStart(2, "0")}`;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetStr}`;
};

function dateGetter(){
    var today = new Date();
    // var dd = String(today.getDate()).padStart(2, '0');
    // var mm = String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
    // var yyyy = today.getFullYear();

    // return today = mm + '/' + dd + '/' + yyyy;
    return formatToDjangoDate(today);
}

module.exports = dateGetter;