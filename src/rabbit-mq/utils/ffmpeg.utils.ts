import fs from "fs"
import Ffmpeg from "fluent-ffmpeg";
import { VideoUploadResolution } from "../interface/video-transcode-job.interface";
import { config } from "../../core/config";
import path from "path";
import { v4 as uuidv4 } from "uuid"
import axios from "axios";

interface Playlist {
    resolution: VideoUploadResolution;
    path: string;
    bandwidth: string;
}

Ffmpeg.setFfmpegPath(config.ffmpeg.path); // Set the path to ffmpeg binary

const transcodeResolution = (
    inputPath: string,
    resolution: VideoUploadResolution,
    outputDir: string,
    queuedTaskId: number
):Promise<Playlist> => {
    return new Promise((resolve, reject) => {
        const resFolder = path.join(outputDir, `${resolution.height}p`);
        fs.mkdirSync(resFolder, { recursive: true });

        const outputM3U8 = path.join(resFolder, `index.m3u8`);
        const inputAbsolutePath = path.resolve(__dirname, '../../../../uploads', inputPath);
        Ffmpeg(inputAbsolutePath)
            .videoCodec("libx264")
            .audioCodec("aac")
            .size(`${resolution.width}x${resolution.height}`)
            .outputOptions([
                "-preset veryfast",
                "-hls_time 10",
                "-hls_playlist_type vod",
                `-b:v ${resolution.bitrate}k`,
                `-r ${resolution.fps}`,
                `-hls_segment_filename ${resFolder}/segment_%03d.ts`
            ])
            .output(outputM3U8)
            .on("start", async (cmd)=>{
                console.log(`FFmpeg started for ${resolution.height}p: ${cmd}`);
                await axios.put(`${config.apiUrl.url}queued-tasks/update/${queuedTaskId}`, {
                    status: "Processing",
                    start_time: new Date()
                })
            })
            .on("progress", (p) => {
                console.log(`${resolution.height}p: ${p.percent?.toFixed(2)}%`);
            })
            .on("end", () => {
                console.log(`${resolution.height}p HLS stream complete`);
                resolve({
                    resolution,
                    path: `${resolution.height}p/index.m3u8`,
                    bandwidth: resolution.bitrate.toString().replace("k", "000")
                });
            })
            .on("error", async (err, stdout, stderr) => {
                console.error(`FFmpeg error for ${resolution.height}p:`, err.message);
                console.error("stdout:", stdout);
                console.error("stderr:", stderr);
                await axios.put(`${config.apiUrl.url}queued-tasks/update/${queuedTaskId}`, {
                    status: "Error",
                    error_message: err.message,
                    end_time: new Date()
                });
                reject(err);
            })
            .run();
    });
        
}

const transcodeVideo = async (
    inputPath: string,
    _outputPath: string,
    resolutions: VideoUploadResolution[],
    queuedTaskId: number,
): Promise<void> => {
    const videoId = uuidv4();
    const outputBasePath = path.resolve(__dirname, '../../../../transcoded-video', videoId);

    if(!fs.existsSync(outputBasePath)){
        fs.mkdirSync(outputBasePath, { recursive: true });
    }

    try {
        const playlistResults = await Promise.all(
            resolutions.map((resolution) => 
                transcodeResolution(inputPath, resolution, outputBasePath, queuedTaskId)
            )
        );

        const masterPlaylistPath = path.join(outputBasePath, "master.m3u8");
        const masterPlaylistContent = playlistResults
            .map(p => `#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},RESOLUTION=${p.resolution.width}x${p.resolution.height}\n${p.path}`)
                .join("\n");

        fs.writeFileSync(masterPlaylistPath, "#EXTM3U\n" + masterPlaylistContent);

        await axios.post(`${config.apiUrl.url}videos/create`,{
            queued_task_id: queuedTaskId,
            video_url: masterPlaylistPath
        })

        await axios.put(`${config.apiUrl.url}queued-tasks/update/${queuedTaskId}`, {
            status: "Completed",
            end_time: new Date()
        });
    } catch (error) {
        console.error("Transcoding failed:", error);
        throw error;
    }
}

export { transcodeVideo }