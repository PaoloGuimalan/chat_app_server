require("dotenv").config()

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const RABBITMQ_PORT = process.env.RABBITMQ_PORT;
const RABBITMQ_USER = process.env.RABBITMQ_USER;
const RABBITMQ_PASS = process.env.RABBITMQ_PASS;

module.exports = {
    rabbitMQ: {
      url: `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_URL}:${RABBITMQ_PORT}`,
      exchangeName: "brokertriggers",
    },
};