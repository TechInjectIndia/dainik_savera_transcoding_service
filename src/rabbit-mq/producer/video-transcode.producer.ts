import { RABBITMQ_CONFIG } from "../config/rabbitmq.config";
import { getChannel } from "../connection/rabbitmq.connection";
import { VideoTranscodeJob } from "../interface/video-transcode-job.interface";

const sendTranscodeVideoJob = async (payload: VideoTranscodeJob ) => {
    const channel = await getChannel();

    await channel.assertQueue(RABBITMQ_CONFIG.queue, { durable: true });
    channel.sendToQueue(RABBITMQ_CONFIG.queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
}

export { sendTranscodeVideoJob }