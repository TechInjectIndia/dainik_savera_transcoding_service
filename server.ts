import http from 'node:http';
import fs from 'node:fs'; // Ensure fs.promises is available
import path from 'node:path'; // Ensure path is available
import { Buffer } from 'node:buffer';
import cors from 'cors'; // Import the cors middleware

import { Server } from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import { EVENTS } from '@tus/utils';
import { FileStore } from '@tus/file-store';

// --- CORS Configuration (using middleware options) ---
const ALLOWED_ORIGIN = 'http://localhost:5173'; // Origin of your Svelte app
const TUS_EXPOSED_HEADERS = [
	'Upload-Offset', 'Upload-Length', 'Tus-Version', 'Tus-Resumable',
	'Tus-Max-Size', 'Tus-Extension', 'Location', 'Upload-Metadata',
];
const TUS_ALLOWED_HEADERS = [
	'Authorization', 'Content-Type', 'Tus-Resumable', 'Upload-Length',
	'Upload-Metadata', 'Upload-Offset', 'X-HTTP-Method-Override', 'X-Requested-With',
];
const TUS_ALLOWED_METHODS = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'];

const corsOptions: cors.CorsOptions = {
	origin: ALLOWED_ORIGIN,
	methods: TUS_ALLOWED_METHODS,
	allowedHeaders: TUS_ALLOWED_HEADERS,
	exposedHeaders: TUS_EXPOSED_HEADERS,
	optionsSuccessStatus: 204
};
const corsMiddleware = cors(corsOptions);


// --- Helper: Parse Upload-Metadata Header ---
function parseMetadata(metadataHeader: string | undefined | null): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) { return metadata; }
	// Ensure metadataHeader is treated as string before calling split
	String(metadataHeader).split(',').forEach((pair) => {
		const kv = pair.trim().split(' ');
		if (kv.length === 2) {
			const key = kv[0];
			try {
				metadata[key] = Buffer.from(kv[1], 'base64').toString('utf-8');
			} catch (e) {
				console.warn(`[Metadata] Failed to decode base64 value for key ${key}:`, e);
				metadata[key] = 'DECODING_ERROR';
			}
		} else if (kv.length === 1 && kv[0]) {
			metadata[kv[0]] = '';
		}
	});
	return metadata;
}

// --- Helper: Sanitize Filename (Re-introduced) ---
function sanitizeFilename(filename: string | undefined | null): string {
	console.log(`[Sanitize] Input filename: ${filename}`); // Log input
	if (!filename) {
		console.log(`[Sanitize] Input is null or empty, returning empty string.`);
		return '';
	}
	// Decode URI components first in case they exist
	let name = decodeURIComponent(filename);
	// Whitelist common safe characters: letters, numbers, hyphen, underscore, period
	// Replace others (including space) with underscore
	name = name.replace(/[^a-zA-Z0-9\.\-\_]/g, '_');
	// Prevent directory traversal and clean up leading/trailing/multiple dots/underscores
	name = name.replace(/^\.+|^\_+|\.+$/g, '').replace(/\.{2,}/g, '_').replace(/\_{2,}/g, '_');
	// Handle empty result after sanitization
	if (!name || name === '.' || name === '_') {
		console.log(`[Sanitize] Result became empty after sanitization, returning empty string.`);
		return '';
	}
	console.log(`[Sanitize] Output filename: ${name}`); // Log output
	return name;
}

// --- Configuration ---
const port = 8085;
const hostname = 'localhost';
const tusPath = '/files/'; // Should end with a slash
const uploadDir = './uploads';

// --- Ensure Upload Directory Exists ---
const absoluteUploadDir = path.resolve(uploadDir);
try {
	await fs.promises.mkdir(absoluteUploadDir, { recursive: true });
	console.log(`[Init] Upload directory created or exists: ${absoluteUploadDir}`);
} catch (error: any) {
	if (error.code !== 'EEXIST') {
		console.error(`[Init] Error creating upload directory ${absoluteUploadDir}:`, error);
		process.exit(1);
	} else {
		console.log(`[Init] Upload directory already exists: ${absoluteUploadDir}`);
	}
}

// --- Create Tus Components ---
const fileStore = new FileStore({ directory: absoluteUploadDir });

const tusServer = new Server({
	path: tusPath,
	datastore: fileStore,
	// Using default naming function
});

// --- Event Handling ---
// Interface might not fully match the actual event in v2.1.0 for POST_FINISH
interface TusFile { id: string; size: number; offset: number; metadata: Record<string, string>; creation_date?: string; }
interface TusEvent {
	file?: TusFile; // Keep optional as it seems missing in POST_FINISH
	// Properties observed in the log for POST_FINISH event:
	method?: string;
	url?: string;
	headers?: http.IncomingHttpHeaders;
	// Add req/res as optional if they might appear in other events
	req?: http.IncomingMessage;
	res?: http.ServerResponse;
}

// --- Modified POST_FINISH Handler ---
tusServer.on(EVENTS.POST_FINISH, async (event: TusEvent) => { // Make handler async
	console.log(`[EVENT:POST_FINISH] Handler invoked.`);
	console.log(`[EVENT:POST_FINISH] Received event object:`, event); // Log the raw event

	// --- Extract info from event (assuming it contains request details) ---
	const requestUrl = event.url;
	const requestHeaders = event.headers;

	if (!requestUrl) {
		console.error(`[EVENT:POST_FINISH] Error: Could not determine upload URL from event.`);
		return;
	}

	// Extract uploadId from the URL (e.g., /files/uploadId)
	// Assumes tusPath ends with a slash
	const urlParts = requestUrl.split(tusPath);
	const uploadId = urlParts[1]; // Get the part after /files/

	if (!uploadId) {
		console.error(`[EVENT:POST_FINISH] Error: Could not parse upload ID from URL: ${requestUrl}`);
		return;
	}

	console.log(`[EVENT:POST_FINISH] ✅ Upload complete for ID (from URL): ${uploadId}.`);

	// --- Attempt to get original filename from headers ---
	const metadata = parseMetadata(requestHeaders?.['upload-metadata'] as string | undefined);
	const originalFilename = metadata?.name; // Uppy sends 'name'
	console.log(`[Rename] Extracted originalFilename from metadata header: ${originalFilename}`);

	if (originalFilename) {
		const sanitizedFilename = sanitizeFilename(originalFilename);

		if (sanitizedFilename) {
			const currentPath = path.join(absoluteUploadDir, uploadId);
			// Construct new name: Use ID prefix to prevent collisions
			const newFilename = `${uploadId}-${sanitizedFilename}`;
			const newPath = path.join(absoluteUploadDir, newFilename);

			console.log(`[Rename] Current path: ${currentPath}`);
			console.log(`[Rename] New path: ${newPath}`);

			try {
				console.log(`[Rename] Checking existence of source file: ${currentPath}`);
				await fs.promises.access(currentPath, fs.constants.F_OK);
				console.log(`[Rename] Source file exists. Attempting rename...`);
				await fs.promises.rename(currentPath, newPath);
				console.log(`[Rename] Successfully renamed file to: ${newFilename}`);
			} catch (renameError: any) {
				console.error(`[Rename] Error during rename process:`, renameError);
				if (renameError.code === 'ENOENT') {
					console.error(`[Rename] Detail: Source file not found at ${currentPath}. Was it already moved or deleted?`);
				}
			}
		} else {
			console.warn(`[Rename] Original filename "${originalFilename}" sanitized to an empty string. File will not be renamed.`);
		}
	} else {
		console.log(`[Rename] No original filename (key 'name') found in metadata header. File will not be renamed.`);
	}
});

tusServer.on(EVENTS.POST_TERMINATE, (event: TusEvent) => {
	// Add safety check here too
	if (!event || !event.file) { // Keep check here as POST_TERMINATE might pass file
		console.error(`[EVENT:POST_TERMINATE] Error: Received POST_TERMINATE event but 'event.file' is missing or undefined.`);
		console.error(`[EVENT:POST_TERMINATE] Received event object:`, event);
		return;
	}
	const resState = event.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.error(`[EVENT:POST_TERMINATE] ⛔ Upload terminated unexpectedly for ID: ${event.file.id}. Response state: ${resState}`);
});

tusServer.on('error' as any, (error: Error, event?: { req: http.IncomingMessage, res: http.ServerResponse }) => {
	const reqId = event?.req?.headers['x-request-id'] || 'N/A';
	const resState = event?.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.error(`[EVENT:tusServer.error] Tus Server Error (Req ID: ${reqId}). Response state: ${resState}`, error);
});


// --- Create HTTP Server with CORS Middleware ---
const httpServer = http.createServer((req, res) => {
	const reqStartTime = Date.now();
	const reqUrl = req.url ?? '';
	const reqMethod = req.method;
	// Only log start for non-OPTIONS requests to reduce noise
	if (reqMethod !== 'OPTIONS') {
		console.log(`[Request START] ${reqMethod} ${reqUrl}`);
		console.log(`[Request START] Initial res state: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
	}

	// --- Apply CORS Middleware ---
	corsMiddleware(req, res, (err?: any) => {
		if (err) {
			console.error("[CORS Middleware Error]", err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error (CORS Configuration)");
			} else if (!res.writableEnded) {
				res.end();
			}
			return;
		}

		// Log after CORS only for non-OPTIONS
		if (reqMethod !== 'OPTIONS') {
			console.log(`[Request CORS] CORS middleware passed. State after CORS: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
		}

		// --- Route Requests ---
		if (reqUrl.startsWith(tusPath)) {
			// Log before handle only for non-OPTIONS
			if (reqMethod !== 'OPTIONS') {
				console.log(`[Request TUS] Routing to tusServer.handle for ${reqMethod} ${reqUrl}. State before handle: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
				res.once('finish', () => {
					console.log(`[Request TUS] Response 'finish' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
				});
				res.once('close', () => {
					console.log(`[Request TUS] Response 'close' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
				});
			}

			tusServer.handle(req, res);

			// Log after handle only for non-OPTIONS
			if (reqMethod !== 'OPTIONS') {
				console.log(`[Request TUS] After calling tusServer.handle for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
			}
			return;
		}

		// --- Handle Other Non-Tus Routes ---
		if (reqUrl === '/') {
			console.log(`[Request Root] Handling GET /`);
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end(`Welcome! Tus endpoint is at ${tusPath}`);
			console.log(`[Request Root] Ended GET / response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
			return;
		}

		// Default 404 for any other route
		console.log(`[Request 404] No route matched for ${reqMethod} ${reqUrl}. State before 404: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
		if (!res.headersSent) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not Found');
			console.log(`[Request 404] Ended 404 response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
		} else if (!res.writableEnded) {
			console.log(`[Request 404] Headers sent, but response not ended. Ending response.`);
			res.end();
		} else {
			console.log(`[Request 404] Headers sent and response ended. Cannot send 404.`);
		}
	}); // End of corsMiddleware call
}); // End of http.createServer

// --- Start Listening ---
httpServer.listen(port, hostname, () => {
	console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
	console.warn(`⚠️ Warning: Server is running without a file locker.`);
	console.info(`ℹ️  Using default server-generated upload IDs.`);
	console.info(`✅ CORS enabled via middleware for origin: ${ALLOWED_ORIGIN}`);
	console.info(`📝 Files will be renamed on completion using 'id-sanitizedOriginalName' format.`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
	console.log('\n[Shutdown] Caught SIGINT, shutting down gracefully...');
	httpServer.close(() => {
		console.log('[Shutdown] HTTP server closed.');
		process.exit(0);
	});
});
