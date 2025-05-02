import { RABBITMQ_CONFIG } from "../config/rabbitmq.config";
import { getChannel } from "../connection/rabbitmq.connection";
import { transcodeVideo } from "../utils/ffmpeg.utils";

const startTranscodeVideoConsumer = async () => {
    const channel = getChannel();

    await channel.assertQueue(RABBITMQ_CONFIG.queue, { durable: true });
    await channel.prefetch(1);
    channel.consume(RABBITMQ_CONFIG.queue, async (msg) => {
        if(msg){
            const data = JSON.parse(msg.content.toString());
            console.log("Transcoding video with data:", data);
            try {
                await transcodeVideo(data.inputPath, data.outputPath, data.resolutions, data.queuedTaskId);
                channel.ack(msg); // Acknowledge the message after processing
            } catch (error) {
                console.log("Error in consumer:", error);
                channel.nack(msg, false, false); // Reject the message and do not requeue it
            }
        }
    },{
        noAck: false // Ensure acknowledgment is required
    })
}

export { startTranscodeVideoConsumer }