function timeGetter(){
    var today = new Date();
    var hour = String(today.getHours() % 12 || 12);
    var minutes = String(today.getMinutes() >= 9? today.getMinutes() : `0${today.getMinutes()}`)
    var seconds = String(today.getSeconds() >= 9? today.getSeconds() : `0${today.getSeconds()}`)
    var timeIndicator = hour >= 12? "am" : "pm"

    return today = `${hour}:${minutes}:${seconds} ${timeIndicator}`;
}

module.exports = timeGetter;