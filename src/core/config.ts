import 'dotenv/config';

const config = {
    port: process.env.PORT || 4000,
    nodeEnv: process.env.NODE_ENV || 'development',
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    },
    storage: {
      uploadDir: process.env.UPLOAD_DIR || 'uploads',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000') // 500MB
    },
    transcoding: {
      qualities: ['360p', '720p'],
      outputDir: process.env.TRANSCODE_OUTPUT_DIR || 'transcoded'
    },
    monitoring: {
      enabled: process.env.MONITORING_ENABLED === 'true',
      datadogApiKey: process.env.DD_API_KEY
    },
    jwt: {
      secret: process.env.JWT_SECRET || 'secret',
      expiresIn: process.env.JWT_EXPIRES_IN || '1d'
    },
    ffmpeg: {
      path: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg'
    },
    rabbitMQ: {
        url: process.env.RABBITMQ_URL || 'amqp://localhost',
        queue: process.env.RABBITMQ_QUEUE || 'transcoding-video'
    },
    schedulerInterval: process.env.SCHEDULER_INTERVAL || 60000,
    apiUrl: {
      url: process.env.API_BASE_URL || 'https://videos.dainiksaveratimes.com/api/'
    }
  };

  export { config }