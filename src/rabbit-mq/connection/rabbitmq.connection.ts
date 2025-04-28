import amqp from 'amqplib';
import { RABBITMQ_CONFIG } from '../config/rabbitmq.config';

let channel: amqp.Channel;

const connectRabbitMQ = async () => {
    const connection = await amqp.connect(RABBITMQ_CONFIG.url);
    channel = await connection.createChannel();
    return channel
}

const getChannel = () => {
    if(!channel){
        throw new Error("RabbitMQ channel not initialized");
    }
    return channel;
}

export { connectRabbitMQ, getChannel}
