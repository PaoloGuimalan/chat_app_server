require("dotenv").config();
const { Client } = require("cassandra-driver");

const CASSANDRA_DB_USERNAME = process.env.CASSANDRA_DB_USERNAME;
const CASSANDRA_DB_PASSWORD = process.env.CASSANDRA_DB_PASSWORD;

let client;

async function connect() {
  if (client) return client;

  client = new Client({
    cloud: {
      secureConnectBundle: "secure-connect-chatterloop.zip",
    },
    credentials: {
      username: CASSANDRA_DB_USERNAME,
      password: CASSANDRA_DB_PASSWORD,
    },
  });

  await client.connect();

  const rs = await client.execute("SELECT * FROM system.local");
  console.log(`Cassandra connection started: ${rs.rowLength}`);

  return client;
}

async function query(q, params, options) {
  if (client) {
    const rs = await client.execute(q, params, options);

    return rs;
  }

  const initial_connection = await connect();
  const initial_rs = await initial_connection.execute(q, params, options);

  return initial_rs;
}

module.exports = {
  connect,
  query,
};
