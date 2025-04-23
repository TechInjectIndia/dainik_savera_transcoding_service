import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
// No longer need uuid for default naming
import {Server} from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import {EVENTS} from '@tus/utils';
import {FileStore} from '@tus/file-store';

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
function parseMetadata(metadataHeader: string | undefined | null): Record<string, string> {
	const metadata: Record<string, string> = {};
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
				console.warn(`[Metadata] Failed to decode base64 value for key ${key}:`, e);
				metadata[key] = 'DECODING_ERROR';
			}
		} else if (kv.length === 1 && kv[0]) {
			metadata[kv[0]] = '';
		}
	});
	return metadata;
}

// --- Configuration ---
const port = 8085;
const hostname = 'localhost';
const tusPath = '/files/';
const uploadDir = './uploads';

// --- Ensure Upload Directory Exists ---
const absoluteUploadDir = path.resolve(uploadDir);
try {
	await fs.promises.mkdir(absoluteUploadDir, {recursive: true});
	console.log(`[Init] Upload directory created or exists: ${absoluteUploadDir}`);
}
catch (error: any) {
	if (error.code !== 'EEXIST') {
		console.error(`[Init] Error creating upload directory ${absoluteUploadDir}:`, error);
		process.exit(1);
	} else {
		console.log(`[Init] Upload directory already exists: ${absoluteUploadDir}`);
	}
}

// --- Create Tus Components ---
const fileStore = new FileStore({directory: absoluteUploadDir});

const tusServer = new Server({
	path: tusPath,
	datastore: fileStore,
	// Using default naming function
});

// --- Event Handling ---
interface TusFile {
	id: string;
	size: number;
	offset: number;
	metadata: Record<string, string>;
	creation_date?: string;
}

// Note: 'req' and 'res' might not be available or reliable in all event handlers
interface TusEvent {
	file: TusFile;
	req?: http.IncomingMessage;
	res?: http.ServerResponse
}

tusServer.on(EVENTS.POST_FINISH, (event: TusEvent) => {
	// Log response state *within* the POST_FINISH event handler
	// Note: The response might have already been sent by the time this fires.
	const resState = event.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.log(`[EVENT:POST_FINISH] ✅ Upload complete for ID: ${event.file.id}. Response state: ${resState}`);
	console.log(`   ID: ${event.file.id}`);
	console.log(`   Size: ${event.file.size} bytes`);
	console.log(`   Offset: ${event.file.offset}`);
	console.log(`   Metadata:`, event.file.metadata);
	const originalFilename = event.file.metadata?.name;
	if (originalFilename) {
		console.log(`   Original filename from metadata: ${originalFilename}`);
	}
	const filePath = path.join(absoluteUploadDir, event.file.id);
	console.log(`   File likely stored at: ${filePath}`);
});

tusServer.on(EVENTS.POST_TERMINATE, (event: TusEvent) => {
	const resState = event.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.error(`[EVENT:POST_TERMINATE] ⛔ Upload terminated unexpectedly for ID: ${event.file.id}. Response state: ${resState}`);
});

// Add a general error listener for the tusServer itself
tusServer.on('error' as any, (error: Error, event?: { req: http.IncomingMessage, res: http.ServerResponse }) => {
	const reqId = event?.req?.headers['x-request-id'] || 'N/A'; // Example: Use a request ID header if available
	const resState = event?.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.error(`[EVENT:tusServer.error] Tus Server Error (Req ID: ${reqId}). Response state: ${resState}`, error);
	// Avoid writing to response here as it might be too late
});


// --- Create HTTP Server with CORS Handling ---
const httpServer = http.createServer((req, res) => {
	const reqStartTime = Date.now();
	const reqUrl = req.url ?? '';
	const reqMethod = req.method;
	console.log(`[Request START] ${reqMethod} ${reqUrl}`);

	// Log initial response state
	console.log(`[Request START] Initial res state: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);

	// --- CORS Header Setup ---
	res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
	res.setHeader('Access-Control-Allow-Methods', TUS_ALLOWED_METHODS);
	res.setHeader('Access-Control-Allow-Headers', TUS_ALLOWED_HEADERS);
	res.setHeader('Access-Control-Expose-Headers', TUS_EXPOSED_HEADERS);
	console.log(`[Request CORS] Set CORS headers. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);


	// --- Handle CORS Preflight (OPTIONS) Requests ---
	if (req.method === 'OPTIONS') {
		console.log(`[Request OPTIONS] Handling OPTIONS preflight for ${reqUrl}`);
		res.writeHead(204); // No Content
		res.end();
		console.log(
		`[Request OPTIONS] Ended OPTIONS response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() -
		reqStartTime}ms`);
		return;
	}

	// --- Route Requests ---

	// Let tus-server handle requests for the tus path
	if (reqUrl.startsWith(tusPath)) {
		console.log(
		`[Request TUS] Routing to tusServer.handle for ${reqMethod} ${reqUrl}. State before handle: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
		// Add listeners to the specific response object to see when it finishes
		res.once('finish', () => {
			console.log(
			`[Request TUS] Response 'finish' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() -
			reqStartTime}ms`);
		});
		res.once('close', () => {
			console.log(
			`[Request TUS] Response 'close' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() -
			reqStartTime}ms`);
		});

		// Call tusServer.handle without .catch() as per previous step
		tusServer.handle(req, res);
		console.log(
		`[Request TUS] After calling tusServer.handle for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
		// Note: tusServer.handle is async internally, so the response might not be finished here yet.
		return; // Let tusServer handle it
	}

	// --- Handle Other Non-Tus Routes ---
	if (reqUrl === '/') {
		console.log(`[Request Root] Handling GET /`);
		res.writeHead(200, {'Content-Type': 'text/plain'});
		res.end(`Welcome! Tus endpoint is at ${tusPath}`);
		console.log(
		`[Request Root] Ended GET / response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() -
		reqStartTime}ms`);
		return;
	}

	// Default 404 for any other route
	console.log(
	`[Request 404] No route matched for ${reqMethod} ${reqUrl}. State before 404: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
	if (!res.headersSent) {
		res.writeHead(404, {'Content-Type': 'text/plain'});
		res.end('Not Found');
		console.log(
		`[Request 404] Ended 404 response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() -
		reqStartTime}ms`);
	} else if (!res.writableEnded) {
		console.log(`[Request 404] Headers sent, but response not ended. Ending response.`);
		res.end();
	} else {
		console.log(`[Request 404] Headers sent and response ended. Cannot send 404.`);
	}
});

// --- Start Listening ---
httpServer.listen(port, hostname, () => {
	console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
	console.warn(`⚠️ Warning: Server is running without a file locker.`);
	console.info(`ℹ️  Using default server-generated upload IDs.`);
	console.info(`✅ CORS enabled for origin: ${ALLOWED_ORIGIN}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
	console.log('\n[Shutdown] Caught SIGINT, shutting down gracefully...');
	httpServer.close(() => {
		console.log('[Shutdown] HTTP server closed.');
		process.exit(0);
	});
});

/**
 **Changes Made:**
1.  **Added Logging:** Introduced several `console.log` statements prefixed with `[Context]` to track the request flow and the state of `res.headersSent` and `res.writableEnded` at different stages:
 * Request start
 * After setting CORS headers
 * Before calling `tusServer.handle`
 * After calling `tusServer.handle` (note: this is synchronous, `handle` works async internally)
 * Inside `OPTIONS` handler
 * Inside `/` handler
 * Inside 404 handler
2.  **Response Event Listeners:** Added `res.once('finish', ...)` and `res.once('close', ...)` specifically for requests handled by `tusServer.handle` to log when the response stream actually finishes or closes.
3.  **Event Handler Logging:** Added logging of the response state within the `POST_FINISH` and `POST_TERMINATE` event handlers (checking `event.res` if available).
4.  **Tus Server Error Listener:** Added a general `tusServer.on('error', ...)` listener to catch errors emitted directly by the server instance, logging the response state if available.
Please restart your Node.js server with this updated code and try the upload again. Pay close attention to the sequence of log messages in the server console, especially the `headersSent` and `writableEnded` values around the time the `✅ Upload complete:` message appears and when the crash occurs. This should give us more insight into exactly when the response state becomes invalid relative to the tus server's actio
 */
