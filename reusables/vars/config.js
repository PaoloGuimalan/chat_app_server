require("dotenv").config()

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const RABBITMQ_PORT = process.env.RABBITMQ_PORT;
const RABBITMQ_USER = process.env.RABBITMQ_USER;
const RABBITMQ_PASS = process.env.RABBITMQ_PASS;

module.exports = {
    realmRoleConfigurationEnabled: process.env.REALM_ROLE_CONFIGURATION_ENABLED === "true",
    communityApprovalsEnabled: process.env.COMMUNITY_APPROVALS_ENABLED === "true",
    rabbitMQ: {
      url: `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_URL}:${RABBITMQ_PORT}`,
      exchangeName: "brokertriggers",
    },
};
