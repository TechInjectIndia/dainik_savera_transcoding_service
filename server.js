import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs'; // Ensure fs.promises is available
import path from 'node:path'; // Ensure path is available
import { Buffer } from 'node:buffer';
import cors from 'cors'; // Import the cors middleware
import { Sequelize, DataTypes, Model } from 'sequelize'; // Import Sequelize
import pg from 'pg'; // <--- Import the pg driver directly
import { Server } from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import { EVENTS } from '@tus/utils';
import { FileStore } from '@tus/file-store';
// --- Database Configuration ---
// Replace with your actual PostgreSQL connection details
const DB_NAME = 'tus_uploads';
const DB_USER = 'tus_user';
const DB_PASS = 'your_password'; // Use environment variables in production!
const DB_HOST = 'localhost';
const DB_PORT = 5432; // Default PostgreSQL port
// --- Initialize Sequelize ---
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
    host: DB_HOST,
    port: DB_PORT,
    dialect: 'postgres',
    dialectModule: pg, // <--- Explicitly provide the imported pg module
    logging: (msg) => console.log('[Sequelize]', msg), // Log Sequelize queries (optional)
});
class Upload extends Model {
    uploadId;
    originalFilename;
    createdAt;
    updatedAt;
}
Upload.init({
    uploadId: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    originalFilename: { type: DataTypes.STRING, allowNull: false },
}, {
    sequelize,
    modelName: 'Upload',
    tableName: 'uploads_metadata',
});
// --- Server Configuration ---
const port = 8085;
const hostname = 'localhost';
const tusPath = '/files/';
const uploadDir = './uploads';
const absoluteUploadDir = path.resolve(uploadDir);
// --- Ensure Upload Directory Exists ---
async function ensureUploadDir() {
    try {
        await fs.promises.mkdir(absoluteUploadDir, { recursive: true });
        console.log(`[Init] Upload directory created or exists: ${absoluteUploadDir}`);
    }
    catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[Init] Error creating upload directory ${absoluteUploadDir}:`, error);
            // Re-throw the error to be caught by initializeApp
            throw error;
        }
        else {
            console.log(`[Init] Upload directory already exists: ${absoluteUploadDir}`);
        }
    }
}
// --- Sync Database and Start Server ---
async function initializeApp() {
    try {
        console.log('[Init] Ensuring upload directory exists...');
        await ensureUploadDir(); // Call the function to create the directory
        console.log('[Init] Authenticating database connection...');
        await sequelize.authenticate();
        console.log('[Sequelize] Connection has been established successfully.');
        console.log('[Init] Synchronizing Sequelize models...');
        await sequelize.sync({ alter: true });
        console.log('[Sequelize] All models were synchronized successfully.');
        console.log('[Init] Starting HTTP server...');
        startHttpServer(); // Start server after successful initialization
    }
    catch (error) {
        // Log the specific error caught during initialization
        console.error('[Init] Failed to initialize application:', error);
        process.exit(1); // Exit if initialization fails
    }
}
// --- CORS Configuration ---
const ALLOWED_ORIGIN = 'http://localhost:5173';
const TUS_EXPOSED_HEADERS = ['Upload-Offset', 'Upload-Length', 'Tus-Version', 'Tus-Resumable', 'Tus-Max-Size', 'Tus-Extension', 'Location', 'Upload-Metadata'];
const TUS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset', 'X-HTTP-Method-Override', 'X-Requested-With'];
const TUS_ALLOWED_METHODS = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'];
const corsOptions = { origin: ALLOWED_ORIGIN, methods: TUS_ALLOWED_METHODS, allowedHeaders: TUS_ALLOWED_HEADERS, exposedHeaders: TUS_EXPOSED_HEADERS, optionsSuccessStatus: 204 };
const corsMiddleware = cors(corsOptions);
// --- Helpers ---
function parseMetadata(metadataHeader) {
    const metadata = {};
    if (!metadataHeader) {
        return metadata;
    }
    String(metadataHeader).split(',').forEach((pair) => {
        const kv = pair.trim().split(' ');
        if (kv.length === 2) {
            const key = kv[0];
            try {
                metadata[key] = Buffer.from(kv[1], 'base64').toString('utf-8');
            }
            catch (e) {
                console.warn(`[Metadata] Failed to decode base64 value for key ${key}:`, e);
                metadata[key] = 'DECODING_ERROR';
            }
        }
        else if (kv.length === 1 && kv[0]) {
            metadata[kv[0]] = '';
        }
    });
    return metadata;
}
function sanitizeFilename(filename) {
    if (!filename) {
        return '';
    }
    let name = decodeURIComponent(filename);
    name = name.replace(/[^a-zA-Z0-9\.\-\_]/g, '_');
    name = name.replace(/^\.+|^\_+|\.+$/g, '').replace(/\.{2,}/g, '_').replace(/\_{2,}/g, '_');
    if (!name || name === '.' || name === '_') {
        return '';
    }
    return name;
}
// --- Create Tus Components ---
const fileStore = new FileStore({ directory: absoluteUploadDir });
const tusServer = new Server({ path: tusPath, datastore: fileStore });
// --- Modified POST_CREATE Handler to save to DB ---
tusServer.on(EVENTS.POST_CREATE, async (event) => {
    console.log(`[EVENT:POST_CREATE] Handler invoked.`);
    const req = event.req;
    const res = event.res;
    const locationHeader = res?.getHeader('Location');
    const metadataHeader = req?.headers['upload-metadata'];
    if (typeof locationHeader !== 'string' || !locationHeader) {
        console.warn(`[EVENT:POST_CREATE] Could not extract Location header from response.`);
        return;
    }
    const urlParts = locationHeader.split(tusPath);
    const uploadId = urlParts[1];
    if (!uploadId) {
        console.warn(`[EVENT:POST_CREATE] Could not parse upload ID from Location header: ${locationHeader}`);
        return;
    }
    const metadata = parseMetadata(metadataHeader);

    const originalFilename = metadata?.name;

    if (originalFilename) {
        try {
            const [record, created] = await Upload.findOrCreate({
                where: { uploadId: uploadId }, defaults: { uploadId: uploadId, originalFilename: originalFilename }
            });
            if (created) {
                console.log(`[EVENT:POST_CREATE] Saved metadata to DB for ID: ${uploadId}, Filename: ${originalFilename}`);
            }
            else {
                console.warn(`[EVENT:POST_CREATE] Metadata record already existed for ID: ${uploadId}.`);
            }
        }
        catch (dbError) {
            console.error(`[EVENT:POST_CREATE] Error saving metadata to DB for ID ${uploadId}:`, dbError);
        }
    }
    else {
        console.warn(`[EVENT:POST_CREATE] Could not save metadata. Original filename ('name') missing in Upload-Metadata header for ID: ${uploadId}.`);
    }
});
// --- Modified POST_FINISH Handler to query DB and rename ---
tusServer.on(EVENTS.POST_FINISH, async (event) => {
    console.log(`[EVENT:POST_FINISH] Handler invoked.`);
    const requestUrl = event.url;
    if (!requestUrl) {
        console.error(`[EVENT:POST_FINISH] Error: Could not determine upload URL from event.`);
        return;
    }
    const urlParts = requestUrl.split(tusPath);
    const uploadId = urlParts[1];
    if (!uploadId) {
        console.error(`[EVENT:POST_FINISH] Error: Could not parse upload ID from URL: ${requestUrl}`);
        return;
    }
    console.log(`[EVENT:POST_FINISH] ✅ Upload complete for ID (from URL): ${uploadId}.`);
    let uploadRecord = null;
    try {
        console.log(`[Rename] Looking up metadata in DB for ID ${uploadId}...`);
        uploadRecord = await Upload.findByPk(uploadId);
        const originalFilename = uploadRecord?.originalFilename;
        console.log(`[Rename] Filename from DB: ${originalFilename}`);
        if (originalFilename) {
            const sanitizedFilename = sanitizeFilename(originalFilename);
            if (sanitizedFilename) {
                const currentPath = path.join(absoluteUploadDir, uploadId);
                const newFilename = `${uploadId}-${sanitizedFilename}`;
                const newPath = path.join(absoluteUploadDir, newFilename);
                console.log(`[Rename] Current path: ${currentPath}`);
                console.log(`[Rename] New path: ${newPath}`);
                try {
                    console.log(`[Rename] Checking existence: ${currentPath}`);
                    await fs.promises.access(currentPath, fs.constants.F_OK);
                    console.log(`[Rename] Exists. Attempting rename...`);
                    await fs.promises.rename(currentPath, newPath);
                    console.log(`[Rename] Successfully renamed file to: ${newFilename}`);
                }
                catch (renameError) {
                    console.error(`[Rename] Error during rename process:`, renameError);
                    return;
                }
            }
            else {
                console.warn(`[Rename] Original filename "${originalFilename}" sanitized to an empty string. File will not be renamed.`);
            }
        }
        else {
            console.log(`[Rename] No metadata record found in DB for ID ${uploadId}. File will not be renamed.`);
        }
    }
    catch (dbError) {
        console.error(`[Rename] Error querying DB for ID ${uploadId}:`, dbError);
        return;
    }
    finally {
        if (uploadRecord) {
            try {
                await uploadRecord.destroy();
                console.log(`[Rename] Removed metadata record from DB for ID ${uploadId}.`);
            }
            catch (deleteError) {
                console.error(`[Rename] Error deleting metadata record from DB for ID ${uploadId}:`, deleteError);
            }
        }
        else {
            console.warn(`[Rename] Could not find metadata record for ID ${uploadId} in DB to remove.`);
        }
    }
});
// --- Modified POST_TERMINATE Handler to delete from DB ---
tusServer.on(EVENTS.POST_TERMINATE, async (event) => {
    let uploadId;
    if (event.file?.id) {
        uploadId = event.file.id;
    }
    else if (event.url) {
        const urlParts = event.url.split(tusPath);
        uploadId = urlParts[1];
    }
    if (uploadId) {
        console.log(`[EVENT:POST_TERMINATE] ⛔ Upload terminated unexpectedly for ID: ${uploadId}.`);
        try {
            const deletedCount = await Upload.destroy({ where: { uploadId: uploadId } });
            if (deletedCount > 0) {
                console.log(`[EVENT:POST_TERMINATE] Cleaned up metadata from DB for terminated upload ID ${uploadId}.`);
            }
            else {
                console.log(`[EVENT:POST_TERMINATE] No metadata found in DB to cleanup for terminated upload ID ${uploadId}.`);
            }
        }
        catch (deleteError) {
            console.error(`[EVENT:POST_TERMINATE] Error cleaning up metadata from DB for terminated upload ID ${uploadId}:`, deleteError);
        }
    }
    else {
        console.error(`[EVENT:POST_TERMINATE] Error: Received POST_TERMINATE event but could not determine upload ID.`);
    }
});
tusServer.on('error', (error, event) => {
    const reqId = event?.req?.headers['x-request-id'] || 'N/A';
    console.error(`[EVENT:tusServer.error] Tus Server Error (Req ID: ${reqId})`, error);
});
// --- Create HTTP Server ---
const httpServer = http.createServer((req, res) => {
    corsMiddleware(req, res, (err) => {
        if (err) {
            console.error("[CORS Middleware Error]", err);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal Server Error (CORS Configuration)");
            }
            else if (!res.writableEnded) {
                res.end();
            }
            return;
        }
        const reqUrl = req.url ?? '';
        if (reqUrl.startsWith(tusPath)) {
            tusServer.handle(req, res);
            return;
        }
        if (reqUrl === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`Welcome! Tus endpoint is at ${tusPath}`);
            return;
        }
        if (!res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
        else if (!res.writableEnded) {
            res.end();
        }
    });
});
// --- Function to Start HTTP Server ---
function startHttpServer() {
    httpServer.listen(port, hostname, () => {
        console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
        console.warn(`⚠️ Warning: Server is running without a file locker.`);
        console.info(`ℹ️  Using default server-generated upload IDs.`);
        console.info(`✅ CORS enabled via middleware for origin: ${ALLOWED_ORIGIN}`);
        console.info(`💾 Storing upload metadata in PostgreSQL.`);
        console.info(`📝 Files will be renamed on completion using 'id-sanitizedOriginalName' format.`);
    });
}
// --- Initialize App (DB connection, then start server) ---
initializeApp(); // Call the main initialization function
// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
    console.log('\n[Shutdown] Caught SIGINT, shutting down gracefully...');
    httpServer.close(async () => {
        console.log('[Shutdown] HTTP server closed.');
        try {
            await sequelize.close();
            console.log('[Shutdown] Database connection closed.');
        }
        catch (dbCloseError) {
            console.error('[Shutdown] Error closing database connection:', dbCloseError);
        }
        finally {
            process.exit(0);
        }
    });
});
