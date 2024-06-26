require("dotenv").config()
const jwt = require("jsonwebtoken")
const UserAccount = require("../../schema/auth/useraccount")
const JWT_SECRET = process.env.JWT_SECRET

const jwtchecker = (req, res, next) => {
    const token = req.headers["x-access-token"]

    if(token){
        jwt.verify(token, JWT_SECRET, async (err, decode) => {
            if(err){
                console.log(err)
                res.send({ status: false, message: err.message })
            }
            else{
                const id = decode.userID;
                await UserAccount.findOne({ userID: id }).then((result) => {
                    if(result){
                        req.params.userID = result.userID;
                        next()
                    }
                    else{
                        res.send({ status: false, message: "Cannot verify user!"})
                    }
                }).catch((err) => {
                    console.log(err)
                    res.send({ status: false, message: "Error verifying user!"})
                })
            }
        })
    }
    else{
        res.send({ status: false, message: "Cannot verify user!"})
    }
}

const jwtssechecker = (req, res, next) => {
    const decodedToken = jwt.verify(req.params.token, JWT_SECRET)

    const token = decodedToken.token
    const type = decodedToken.type

    if(token){
        jwt.verify(token, JWT_SECRET, async (err, decode) => {
            if(err){
                console.log(err)
                res.sse(type, { status: false, auth: false, message: err.message })
            }
            else{
                const id = decode.userID;
                await UserAccount.findOne({ userID: id }).then((result) => {
                    if(result){
                        req.params.userID = result.userID;
                        next()
                    }
                    else{
                        res.sse(type, { status: false, auth: false, message: "Cannot verify user!"})
                    }
                }).catch((err) => {
                    console.log(err)
                    res.sse(type, { status: false, auth: false, message: "Error verifying user!"})
                })
            }
        })
    }
    else{
        res.send(type, { status: false, auth: false, message: "Cannot verify user!"})
    }
}

const createJWT = (payload) => {
    const encodedResult = jwt.sign({
        data: payload
    }, JWT_SECRET)

    return encodedResult;
}

const createJWTwExp = (payload) => {
    const encodedResult = jwt.sign(payload, JWT_SECRET, {
        expiresIn: 60 * 60 * 24 * 7
    })

    return encodedResult;
}

module.exports = {
    jwtchecker,
    jwtssechecker,
    createJWT,
    createJWTwExp
}