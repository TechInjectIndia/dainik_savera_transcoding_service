import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import cors from 'cors'; // Import the cors middleware

import { Server } from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import { EVENTS } from '@tus/utils';
import { FileStore } from '@tus/file-store';

// --- CORS Configuration (using middleware options) ---
const ALLOWED_ORIGIN = 'http://localhost:5173'; // Origin of your Svelte app

// Headers required by the tus protocol that the client needs access to
const TUS_EXPOSED_HEADERS = [
	'Upload-Offset',
	'Upload-Length',
	'Tus-Version',
	'Tus-Resumable',
	'Tus-Max-Size',
	'Tus-Extension',
	'Location', // Important for retrieving the upload URL
	'Upload-Metadata', // Expose if client needs to read it back
]; // Note: No .join(', ') needed for the cors package options

// Headers the client is allowed to send
const TUS_ALLOWED_HEADERS = [
	'Authorization', // If you use authentication
	'Content-Type',
	'Tus-Resumable',
	'Upload-Length',
	'Upload-Metadata',
	'Upload-Offset',
	'X-HTTP-Method-Override', // Used by some clients for PATCH/DELETE over POST
	'X-Requested-With',
]; // Note: No .join(', ') needed for the cors package options

const TUS_ALLOWED_METHODS = [
	'POST', // Create an upload
	'PATCH', // Upload chunks
	'HEAD', // Check upload status
	'DELETE', // Terminate an upload
	'OPTIONS', // CORS preflight
]; // Note: No .join(', ') needed for the cors package options

// Configure the cors middleware
const corsOptions: cors.CorsOptions = {
	origin: ALLOWED_ORIGIN, // Allow only your Svelte app's origin
	methods: TUS_ALLOWED_METHODS,
	allowedHeaders: TUS_ALLOWED_HEADERS,
	exposedHeaders: TUS_EXPOSED_HEADERS,
	optionsSuccessStatus: 204 // Use 204 No Content for preflight success
};

// Create a cors middleware instance
const corsMiddleware = cors(corsOptions);


// --- Helper: Parse Upload-Metadata Header ---
function parseMetadata(metadataHeader: string | undefined | null): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) { return metadata; }
	metadataHeader.split(',').forEach((pair) => {
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

// --- Configuration ---
const port = 8085;
const hostname = 'localhost';
const tusPath = '/files/';
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
interface TusFile { id: string; size: number; offset: number; metadata: Record<string, string>; creation_date?: string; }
interface TusEvent { file: TusFile; req?: http.IncomingMessage; res?: http.ServerResponse }

tusServer.on(EVENTS.POST_FINISH, (event: TusEvent) => {
	const resState = event.res ? `headersSent=${event.res.headersSent}, writableEnded=${event.res.writableEnded}` : 'Response object not available';
	console.log(`[EVENT:POST_FINISH] ✅ Upload complete for ID: ${event.file.id}. Response state: ${resState}`);
	console.log(`   ID: ${event.file.id}`);
	console.log(`   Size: ${event.file.size} bytes`);
	console.log(`   Offset: ${event.file.offset}`);
	console.log(`   Metadata:`, event.file.metadata);
	const originalFilename = event.file.metadata?.name;
	if (originalFilename) { console.log(`   Original filename from metadata: ${originalFilename}`); }
	const filePath = path.join(absoluteUploadDir, event.file.id);
	console.log(`   File likely stored at: ${filePath}`);
});

tusServer.on(EVENTS.POST_TERMINATE, (event: TusEvent) => {
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
	console.log(`[Request START] ${reqMethod} ${reqUrl}`);
	console.log(`[Request START] Initial res state: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);

	// --- Apply CORS Middleware ---
	// The cors middleware handles setting headers and responding to OPTIONS requests.
	// It calls the 'next' function (the third argument here) if the request
	// is allowed and not an OPTIONS request that it handled.
	corsMiddleware(req, res, (err?: any) => {
		// This callback function acts as our 'next' handler after CORS checks.
		if (err) {
			// Handle errors from the CORS middleware itself (e.g., configuration error)
			console.error("[CORS Middleware Error]", err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error (CORS Configuration)");
			} else if (!res.writableEnded) {
				res.end();
			}
			return;
		}

		// --- CORS check passed, proceed with routing ---
		console.log(`[Request CORS] CORS middleware passed. State after CORS: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);

		// --- Route Requests ---

		// Let tus-server handle requests for the tus path
		if (reqUrl.startsWith(tusPath)) {
			console.log(`[Request TUS] Routing to tusServer.handle for ${reqMethod} ${reqUrl}. State before handle: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
			res.once('finish', () => {
				console.log(`[Request TUS] Response 'finish' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
			});
			res.once('close', () => {
				console.log(`[Request TUS] Response 'close' event fired for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
			});

			tusServer.handle(req, res);
			console.log(`[Request TUS] After calling tusServer.handle for ${reqMethod} ${reqUrl}. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
			// Return is important here because tusServer.handle manages the response asynchronously
			return;
		}

		// --- Handle Other Non-Tus Routes ---
		if (reqUrl === '/') {
			console.log(`[Request Root] Handling GET /`);
			// CORS headers were already handled by the middleware
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end(`Welcome! Tus endpoint is at ${tusPath}`);
			console.log(`[Request Root] Ended GET / response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
			return;
		}

		// Default 404 for any other route
		console.log(`[Request 404] No route matched for ${reqMethod} ${reqUrl}. State before 404: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}`);
		if (!res.headersSent) {
			// CORS headers were already handled by the middleware
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not Found');
			console.log(`[Request 404] Ended 404 response. State: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}. Duration: ${Date.now() - reqStartTime}ms`);
		} else if (!res.writableEnded) {
			console.log(`[Request 404] Headers sent, but response not ended. Ending response.`);
			res.end();
		} else {
			console.log(`[Request 404] Headers sent and response ended. Cannot send 404.`);
		}
		// End of routing within the CORS callback
	}); // End of corsMiddleware call

}); // End of http.createServer

// --- Start Listening ---
httpServer.listen(port, hostname, () => {
	console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
	console.warn(`⚠️ Warning: Server is running without a file locker.`);
	console.info(`ℹ️  Using default server-generated upload IDs.`);
	console.info(`✅ CORS enabled via middleware for origin: ${ALLOWED_ORIGIN}`); // Updated info message
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
	console.log('\n[Shutdown] Caught SIGINT, shutting down gracefully...');
	httpServer.close(() => {
		console.log('[Shutdown] HTTP server closed.');
		process.exit(0);
	});
});
