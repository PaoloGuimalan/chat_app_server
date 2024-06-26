require("dotenv").config()
const amqp = require('amqplib');
const config = require('../vars/config');

const POD_NAME = process.env.POD_NAME || "podless";

//step 1 : Connect to the rabbitmq server
//step 2 : Create a new channel on that connection
//step 3 : Create the exchange
//step 4 : Publish the message to the exchange with a routing key

class Producer {
  channel;

  async createChannel() {
    try{
        const connection = await amqp.connect(config.rabbitMQ.url);
        this.channel = await connection.createChannel();
    }
    catch(ex){
        console.log("Message broker not in bound");
    }
  }

  async publishMessage(routingKey, event, message) {
    try{
        if (!this.channel) {
            await this.createChannel();
          }
      
          const exchangeName = config.rabbitMQ.exchangeName;
          await this.channel.assertExchange(exchangeName, "fanout");
      
          const logDetails = {
            logType: routingKey,
            pod: POD_NAME,
            event: event,
            message: message,
            dateTime: new Date(),
          };
          await this.channel.publish(
            exchangeName,
            '', //routingKey
            Buffer.from(JSON.stringify(logDetails))
          );
      
          console.log(
            `The new ${routingKey} log is sent to exchange ${exchangeName}`
          );
    }
    catch(ex){
        console.log("No message broker initialized");
    }
  }
}

const producer = new Producer();

module.exports = producer;