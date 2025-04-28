import express, { Request, Response } from 'express';
import { config } from './core/config';
import { startPendingTasksScheduler } from './rabbit-mq/schedulers/pending-tasks.scheduler';
import { connectRabbitMQ } from './rabbit-mq/connection/rabbitmq.connection';
import { startTranscodeVideoConsumer } from './rabbit-mq/consumer/rabbitmq.consumer';

const app = express();
const PORT = config.port;

app.use(express.json());

app.get('/', (req: Request, res: Response) => {
  res.send('Hello from Transcoding Express Server!');
});


const startServer = async () => {
    try {
        await connectRabbitMQ()
        await startTranscodeVideoConsumer();
        app.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
        startPendingTasksScheduler();
    } catch (error) {
        console.error('Error starting the server:', error);
    }
}

startServer();

export { app };

