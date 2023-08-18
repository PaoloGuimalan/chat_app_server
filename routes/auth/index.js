const express = require("express")
const router = express.Router()

router.use((req, res, next) => {
    next()
})

router.get('/login', (req, res) => {
    res.send("OK")
})

module.exports = router;