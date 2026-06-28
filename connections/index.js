require("dotenv").config();
const MONGODB_CLUSTER_PASS = process.env.MONGODB_CLUSTER_PASS;

module.exports = {
    // Local-dev override: set MONGODB_URI to a local mongo (e.g.
    // mongodb://localhost:27017/chatterloop). Falls back to the cloud cluster.
    url: process.env.MONGODB_URI || `mongodb+srv://dt187:${MONGODB_CLUSTER_PASS}@cluster0.6uzwm.mongodb.net/chatterloop?w=majority`,
    params:{
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
}