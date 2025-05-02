import axios from "axios";
import { config } from "../../core/config";
import { getChannel } from "../connection/rabbitmq.connection";
import { RABBITMQ_CONFIG } from "../config/rabbitmq.config";
import { VideoTranscodeJob } from "../interface/video-transcode-job.interface";
import { sendTranscodeVideoJob } from "../producer/video-transcode.producer";

const SCHEDULER_INTERVAL = Number(process.env.SCHEDULER_INTERVAL) || 60000;// 1 minute

const processPendingTasks = async () => {
    try {
        const availableSlots = await getAvailableQueueSlots();
        if(availableSlots <= 0){
            console.log(`[Scheduler] Queue is full. Skipping this cycle.`);
            return;
        }

        const pendingTasks = await fetchPendingTasks(availableSlots);
        console.log('pendingTasks: ', pendingTasks);
        if (pendingTasks.length === 0) {
            console.log(`[Scheduler] No pending tasks to process.`);
            return;
        }
        for (const task of pendingTasks) {
            await processTask(task);
        }
    } catch (error) {
        console.error("Error processing pending tasks:", error);
    }
}

const getAvailableQueueSlots = async (): Promise<number> => {
    const channel = getChannel();
    const MAX_QUEUE_CAPACITY = 10;
    const { messageCount } = await channel.checkQueue(RABBITMQ_CONFIG.queue);
    console.log('messageCount: ', messageCount);
    return MAX_QUEUE_CAPACITY - messageCount;
}

const fetchPendingTasks = async (limit: number): Promise<any[]> => {
    try{
        const response = await axios.get(`${config.apiUrl.url}queued-tasks/pendingList`,{
            params: {
                limit: limit
            }
        })
        return response.data.data;
    }catch(error){
        console.error("Error fetching pending tasks:", error);
        return [];
    }
}

const processTask = async (task: any): Promise<any> => {
    try {
        const videoUpload = task.videoUpload;
        const jobPayload:VideoTranscodeJob = {
            inputPath: videoUpload.path,
            outputPath: `transcoded/${Date.now()}-${videoUpload.title}`,
            resolutions: videoUpload.resolution,
            queuedTaskId: task.id
        }
        await sendTranscodeVideoJob(jobPayload);
        // await updateTaskStatus(task.id, 'Queued');
    } catch (error) {
        console.error("Error processing task:", error);
        await updateTaskStatus(task.id, 'Error', error);
    }
}

const updateTaskStatus = async (taskId: string, status: string, error?:unknown): Promise<void> => {
    try {
        const payload:any = {
            status
        }
        if(status === 'Error' && error){
            payload.error_message = error instanceof Error ? error.message : "Unknown error";
        }
        await axios.patch(`${config.apiUrl.url}queued-tasks/updateStatus/${taskId}`, payload);
    } catch (error) {
        console.error("Error updating task status:", error);
    }
}

const startPendingTasksScheduler = () => {
    setInterval(processPendingTasks, SCHEDULER_INTERVAL);
}

export { startPendingTasksScheduler } 