import { config } from "../../core/config"

const RABBITMQ_CONFIG = {
    url: config.rabbitMQ.url || 'amqp://localhost',
    queue: config.rabbitMQ.queue || 'transcoding-video',
}

export {RABBITMQ_CONFIG}