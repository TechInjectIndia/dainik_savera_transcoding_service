import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { v4 as uuidv4 } from 'uuid';
import { Server } from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import { EVENTS } from '@tus/utils';
import { FileStore } from '@tus/file-store';
// --- CORS Configuration ---
const ALLOWED_ORIGIN = 'http://localhost:5173'; // Origin of your Svelte app
const TUS_EXPOSED_HEADERS = [
    'Upload-Offset', 'Upload-Length', 'Tus-Version', 'Tus-Resumable',
    'Tus-Max-Size', 'Tus-Extension', 'Location', 'Upload-Metadata',
].join(', ');
const TUS_ALLOWED_HEADERS = [
    'Authorization', 'Content-Type', 'Tus-Resumable', 'Upload-Length',
    'Upload-Metadata', 'Upload-Offset', 'X-HTTP-Method-Override', 'X-Requested-With',
].join(', ');
const TUS_ALLOWED_METHODS = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'].join(', ');
// --- Helper: Parse Upload-Metadata Header ---
function parseMetadata(metadataHeader) {
    const metadata = {};
    if (!metadataHeader) {
        return metadata;
    }
    metadataHeader.split(',').forEach((pair) => {
        const kv = pair.trim().split(' ');
        if (kv.length === 2) {
            const key = kv[0];
            try {
                metadata[key] = Buffer.from(kv[1], 'base64').toString('utf-8');
            }
            catch (e) {
                console.warn(`Failed to decode base64 metadata value for key ${key}:`, e);
                metadata[key] = 'DECODING_ERROR';
            }
        }
        else if (kv.length === 1 && kv[0]) {
            metadata[kv[0]] = '';
        }
    });
    return metadata;
}
// --- Helper: Sanitize Filename ---
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
// --- Configuration ---
const port = 8085;
const hostname = 'localhost';
const tusPath = '/files/';
const uploadDir = './uploads';
const MAX_ID_LENGTH = 150;
// --- Ensure Upload Directory Exists ---
const absoluteUploadDir = path.resolve(uploadDir);
try {
    await fs.promises.mkdir(absoluteUploadDir, { recursive: true });
    console.log(`Upload directory created or exists: ${absoluteUploadDir}`);
}
catch (error) {
    if (error.code !== 'EEXIST') {
        console.error(`Error creating upload directory ${absoluteUploadDir}:`, error);
        process.exit(1);
    }
    else {
        console.log(`Upload directory already exists: ${absoluteUploadDir}`);
    }
}
// --- Create Tus Components ---
const fileStore = new FileStore({ directory: absoluteUploadDir });
const tusServer = new Server({
    path: tusPath,
    datastore: fileStore,
    namingFunction: (req) => {
        // Using 'name' from Uppy's default metadata
        const metadata = parseMetadata(req.headers['upload-metadata']);
        const originalFilename = metadata.name || metadata.filename; // Check for 'name' first
        const sanitized = sanitizeFilename(originalFilename);
        const uniquePrefix = uuidv4().substring(0, 8);
        let finalId;
        if (sanitized) {
            finalId = `${uniquePrefix}-${sanitized}`;
            if (finalId.length > MAX_ID_LENGTH) {
                const availableLength = MAX_ID_LENGTH - (uniquePrefix.length + 1);
                const safeAvailableLength = Math.max(0, availableLength);
                finalId = `${uniquePrefix}-${sanitized.substring(0, safeAvailableLength)}`;
                finalId = finalId.replace(/[\.\_]$/, '');
            }
        }
        else {
            console.warn('No usable filename/name in metadata, generating full UUID for ID.');
            finalId = uuidv4();
        }
        console.log(`Generated upload ID: ${finalId}`);
        return finalId;
    },
});
tusServer.on(EVENTS.POST_FINISH, (event) => {
    console.log(`✅ Upload complete:`);
    console.log(`   ID: ${event.file.id}`);
    console.log(`   Size: ${event.file.size} bytes`);
    console.log(`   Offset: ${event.file.offset}`);
    console.log(`   Metadata:`, event.file.metadata);
    const originalFilename = event.file.metadata?.name || event.file.metadata?.filename;
    if (originalFilename) {
        console.log(`   Original filename from metadata: ${originalFilename}`);
    }
    const filePath = path.join(absoluteUploadDir, event.file.id);
    console.log(`   File likely stored at: ${filePath}`);
});
tusServer.on(EVENTS.POST_TERMINATE, (event) => {
    console.error(`⛔ Upload terminated unexpectedly for ID: ${event.file.id}`);
    // You could add more detailed logging here if needed
});
// --- Create HTTP Server with CORS Handling ---
const httpServer = http.createServer((req, res) => {
    // --- CORS Header Setup ---
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', TUS_ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', TUS_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', TUS_EXPOSED_HEADERS);
    // --- Handle CORS Preflight (OPTIONS) Requests ---
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    // --- Route Requests ---
    const requestUrl = req.url ?? '';
    // Let tus-server handle requests for the tus path
    if (requestUrl.startsWith(tusPath)) {
        // Removed the .catch() block here. Errors happening *after* handle()
        // completes successfully might still be logged by Node or tusServer,
        // but we won't try to send a 500 response if headers are already sent.
        tusServer.handle(req, res);
        return; // Let tusServer handle it
    }
    // --- Handle Other Non-Tus Routes ---
    if (requestUrl === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Welcome! Tus endpoint is at ${tusPath}`);
        return;
    }
    // Default 404 for any other route
    if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
    else if (!res.writableEnded) {
        res.end();
    }
});
// --- Start Listening ---
httpServer.listen(port, hostname, () => {
    console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
    console.warn(`⚠️ Warning: Server is running without a file locker.`);
    console.info(`ℹ️  Upload IDs generated using client filename metadata (if available).`);
    console.info(`✅ CORS enabled for origin: ${ALLOWED_ORIGIN}`);
});
// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('\nCaught SIGINT, shutting down gracefully...');
    httpServer.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});
