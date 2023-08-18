require("dotenv").config();
const MONGODB_CLUSTER_PASS = process.env.MONGODB_CLUSTER_PASS;

module.exports = {
    url: `mongodb+srv://dt187:${MONGODB_CLUSTER_PASS}@cluster0.6uzwm.mongodb.net/chatterloop?w=majority`,
    params:{
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
}