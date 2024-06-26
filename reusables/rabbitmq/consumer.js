require("dotenv").config()
const amqp = require('amqplib');
const config = require('../vars/config');
const { SEND_TAG_POST_NOTIFICATION, BROADCAST_IS_TYPING_STATUS_LOOPER, SSE_NOTIFICATIONS_TRIGGER, CONTACT_LIST_TRIGGER_LOOPER, REACH_CALL_RECEPIENTS_LOOPER, UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER, CALL_REJECT_NOTIF, CALL_REJECT_NOTIF_LOOPER, MESSAGES_TRIGGER_LOOPER } = require("../vars/rabbitmqevents");
const { SSENotificationsTrigger, MessagesTrigger, ContactListTrigger, ReachCallRecepients, UpdateContactswSessionStatus, CallRejectNotif, SendTagPostNotification, BroadcastIsTypingStatus } = require("../hooks/sse");
const POD_NAME = process.env.POD_NAME || "podless";

//step 1 : Connect to the rabbitmq server
//step 2 : Create a new channel
//step 3 : Create the exchange
//step 4 : Create the queue
//step 5 : Bind the queue to the exchange
//step 6 : Consume messages from the queue

function brokerActions (data) {
  try{
    const parameters = data.message.parameters;

    switch(data.event){
      case SSE_NOTIFICATIONS_TRIGGER:
        SSENotificationsTrigger(parameters.type, parameters.ids, parameters.details);
        break;
      case MESSAGES_TRIGGER_LOOPER:
        parameters.receivers.map((rcvs) => {
          MessagesTrigger(rcvs, parameters.sender, parameters.onseen);
        });
        break;
      case CONTACT_LIST_TRIGGER_LOOPER:
        parameters.receivers.map((rcvs) => {
          ContactListTrigger(rcvs, parameters.details);
        });
        break;
      case REACH_CALL_RECEPIENTS_LOOPER:
        parameters.recepients.map((rcp) => {
          ReachCallRecepients(rcp, parameters.decodedToken);
        })
        break;
      case UPDATE_CONTATCS_W_SESSION_STATUS_LOOPER:
        parameters.contacts.map((mp) => {
          UpdateContactswSessionStatus(mp, parameters.decodedToken);
        });
        break;
      case CALL_REJECT_NOTIF:
        CallRejectNotif(parameters.rcp, parameters.decodedToken);
        break;
      case CALL_REJECT_NOTIF_LOOPER:
        parameters.recepients.map((mp) => {
          CallRejectNotif(mp, parameters.decodedToken);
        })
        break;
      case SEND_TAG_POST_NOTIFICATION:
        SendTagPostNotification(parameters.details, parameters.userID);
        break;
      case BROADCAST_IS_TYPING_STATUS_LOOPER:
        parameters.receivers.map((mp) => {
          BroadcastIsTypingStatus(mp, parameters.data);
        })
        break;
      default:
        break;
    }
  }catch(ex){
    console.log("Action Invalid: ", data, data.message.parameters, ex);
  }
}

async function consumeMessages() {
  try{
    const connection = await amqp.connect(config.rabbitMQ.url);
    const channel = await connection.createChannel();
  
    await channel.assertExchange(config.rabbitMQ.exchangeName, "fanout");
  
    const q = await channel.assertQueue("");
  
    await channel.bindQueue(q.queue, config.rabbitMQ.exchangeName, "");
  //   await channel.bindQueue(q.queue, config.rabbitMQ.exchangeName, "INFO");
  //   await channel.bindQueue(q.queue, config.rabbitMQ.exchangeName, "WARNING");
  //   await channel.bindQueue(q.queue, config.rabbitMQ.exchangeName, "ERROR");
  
    channel.consume(q.queue, (msg) => {
      const data = JSON.parse(msg.content);
      channel.ack(msg);

      //action trigger: { logType: "INFO", message: any, pod: podname, event: event_string, dateTime: date_value }
      if(data.pod !== POD_NAME && data.logType === "INFO:CHATTERLOOP"){
        // console.log(data);
        brokerActions(data);
      }
    });
  }catch(ex){
    console.log("Unable to connect message broker");
  }
}

module.exports = consumeMessages;