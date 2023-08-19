const bycrypt = require("bcrypt")

var roundEnc = 10

function encode(data){
    var genSaltRes = bycrypt.genSaltSync(roundEnc)
    var encoded = bycrypt.hashSync(data, genSaltRes)

    return encoded
}

function decode(plain, hash){
    var decodestatus = bycrypt.compareSync(plain, hash)

    return decodestatus
}

module.exports = { encode, decode }