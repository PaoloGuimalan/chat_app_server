// db.js
require("dotenv").config();
const { Pool } = require("pg");

const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME;
const DB_PORT = process.env.DB_PORT;
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;

let pool; // singleton instance

function createPool() {
  const newPool = new Pool({
    user: DB_USERNAME,
    host: DB_HOST,
    database: DB_NAME,
    password: DB_PASSWORD,
    port: DB_PORT,
    max: 100, // max number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  newPool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client", err);
    process.exit(-1);
  });

  // Trigger connection immediately on creation
  newPool
    .connect()
    .then((client) => {
      console.log("PostgreSQL connected successfully at startup.");
      client.release();
    })
    .catch((err) => {
      console.error("PostgreSQL connection failed at startup:", err);
      process.exit(1);
    });

  return newPool;
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

async function query(text, params) {
  if (!pool) {
    throw new Error("Pool has not been initialized yet.");
  }
  return pool.query(text, params);
}

function releaseClient(client) {
  try {
    if (client && typeof client.release === "function") {
      client.release();
    } else if (client && typeof client.end === "function") {
      // Fallback for non-pooled clients (not recommended)
      console.log("END POOL");
      //   client.end();
    }
  } catch (err) {
    console.error("Error releasing PostgreSQL client:", err);
  }
}

module.exports = {
  getPool,
  query,
  releaseClient,
};
