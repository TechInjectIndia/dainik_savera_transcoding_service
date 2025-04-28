interface VideoUploadResolution {
    width: number;
    height: number;
    bitrate: number;
    fps: number;
}

interface VideoTranscodeJob {
    inputPath: string;
    outputPath: string;
    resolutions: VideoUploadResolution[];
    queuedTaskId: number;
}


export { VideoTranscodeJob, VideoUploadResolution }