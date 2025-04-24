import http from 'node:http';
import fs from 'node:fs'; // Ensure fs.promises is available
import path from 'node:path'; // Ensure path is available
import { Buffer } from 'node:buffer';
import cors from 'cors'; // Import the cors middleware
import { Sequelize, DataTypes, Model, Transaction, Op } from 'sequelize'; // Import Sequelize, Op
import pg from 'pg'; // Import the pg driver directly
import cron from 'node-cron'; // Import node-cron
import { Upload } from '@tus/server'; // Import Upload type

import { Server } from '@tus/server';
// Assuming EVENTS import from @tus/utils works, otherwise adjust as needed
import { EVENTS } from '@tus/utils';
import { FileStore } from '@tus/file-store'; // Import the base store

// --- Database Configuration ---
// Using placeholder values - REMEMBER TO REPLACE with your actual credentials
const DB_NAME = 'dainik_savera'; // Your DB name
const DB_USER = 'postgres'; // Your DB user
const DB_PASS = 'postgres'; // Your DB password - Use env vars in production!
const DB_HOST = 'localhost';
const DB_PORT = 5432;

// --- Initialize Sequelize ---
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
	host: DB_HOST,
	port: DB_PORT,
	dialect: 'postgres',
	dialectModule: pg, // Explicitly provide the imported pg module
	logging: (msg:any) => console.log('[Sequelize]', msg), // Log Sequelize queries (optional)
	//todo sunil
	// pool: false, // Disable pooling for simplicity
});

// --- Define Sequelize Model ---
// --- Updated UploadAttributes Interface ---
interface UploadAttributes {
	uploadId: string;
	originalFilename: string;
	// Add timestamps to the interface to allow querying them
	createdAt?: Date; // Make optional as they are auto-generated
	updatedAt?: Date;
}
// --- End Update ---

class UploadModel extends Model<UploadAttributes> implements UploadAttributes {
	// Declare types for TypeScript, but don't initialize them here
	declare uploadId: string;
	declare originalFilename: string;
	declare readonly createdAt: Date; // Keep readonly here for the instance property
	declare readonly updatedAt: Date;
}
UploadModel.init({
	uploadId: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
	originalFilename: { type: DataTypes.STRING, allowNull: false },
	// Sequelize automatically adds createdAt and updatedAt columns
}, {
	sequelize,
	modelName: 'Upload', // Keep model name simple
	tableName: 'uploads_metadata',
	// timestamps: true is the default, explicitly stating it is also fine
	timestamps: true,
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
	} catch (error: any) {
		if (error.code !== 'EEXIST') {
			console.error(`[Init] Error creating upload directory ${absoluteUploadDir}:`, error);
			throw error; // Re-throw to be caught by initializeApp
		} else {
			console.log(`[Init] Upload directory already exists: ${absoluteUploadDir}`);
		}
	}
}

// --- Sync Database and Start Server ---
async function initializeApp() {
	try {
		console.log('[Init] Ensuring upload directory exists...');
		await ensureUploadDir();
		console.log('[Init] Authenticating database connection...');
		await sequelize.authenticate();
		console.log('[Sequelize] Connection has been established successfully.');
		console.log('[Init] Synchronizing Sequelize models...');
		await sequelize.sync({ alter: true });
		console.log('[Sequelize] All models were synchronized successfully.');
		console.log('[Init] Starting HTTP server...');
		startHttpServer(); // Start server
		console.log('[Init] Scheduling database cleanup job...');
		scheduleDatabaseCleanup(); // Schedule cleanup job after server starts
	} catch (error) {
		console.error('[Init] Failed to initialize application:', error);
		process.exit(1);
	}
}

// --- CORS Configuration ---
const ALLOWED_ORIGIN = 'http://localhost:5173';
const TUS_EXPOSED_HEADERS = [ 'Upload-Offset', 'Upload-Length', 'Tus-Version', 'Tus-Resumable', 'Tus-Max-Size', 'Tus-Extension', 'Location', 'Upload-Metadata' ];
const TUS_ALLOWED_HEADERS = [ 'Authorization', 'Content-Type', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset', 'X-HTTP-Method-Override', 'X-Requested-With' ];
const TUS_ALLOWED_METHODS = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'];
const corsOptions: cors.CorsOptions = { origin: ALLOWED_ORIGIN, methods: TUS_ALLOWED_METHODS, allowedHeaders: TUS_ALLOWED_HEADERS, exposedHeaders: TUS_EXPOSED_HEADERS, optionsSuccessStatus: 204 };
const corsMiddleware = cors(corsOptions);

// --- Helpers ---
function parseMetadata(metadataHeader: string | undefined | null): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) { return metadata; }
	String(metadataHeader).split(',').forEach((pair) => {
		const kv = pair.trim().split(' ');
		if (kv.length === 2) {
			const key = kv[0];
			try { metadata[key] = Buffer.from(kv[1], 'base64').toString('utf-8'); }
			catch (e) { console.warn(`[Metadata] Failed to decode base64 value for key ${key}:`, e); metadata[key] = 'DECODING_ERROR'; }
		} else if (kv.length === 1 && kv[0]) { metadata[kv[0]] = ''; }
	});
	return metadata;
}
function sanitizeFilename(filename: string | undefined | null): string {
	if (!filename) { return ''; }
	let name = decodeURIComponent(filename);
	name = name.replace(/[^a-zA-Z0-9\.\-\_]/g, '_');
	name = name.replace(/^\.+|^\_+|\.+$/g, '').replace(/\.{2,}/g, '_').replace(/\_{2,}/g, '_');
	if (!name || name === '.' || name === '_') { return ''; }
	return name;
}

// --- Custom DataStore to Save Metadata to DB on Create ---
class FileStoreWithDbMetadata extends FileStore {
	constructor(options: { directory: string }) {
		super(options);
		console.log('[DataStore] Custom FileStoreWithDbMetadata initialized.');
	}

	async create(file: Upload): Promise<Upload> {
		console.log('[DataStore] create() method invoked.');

		const uploadId = file.id;
		const originalFilename = file.metadata?.name;
		console.log(`[DataStore] Extracted uploadId: ${uploadId}`);
		console.log(`[DataStore] Extracted originalFilename from file.metadata: ${originalFilename}`);

		let transaction: Transaction | null = null;
		try {
			transaction = await sequelize.transaction();

			if (uploadId && originalFilename) {
				const [record, created] = await UploadModel.findOrCreate({
					where: { uploadId: uploadId },
					defaults: { uploadId: uploadId, originalFilename: originalFilename },
					transaction: transaction
				});
				if (created) { console.log(`[DataStore] Saved metadata to DB for ID: ${uploadId}, Filename: ${originalFilename}`); }
				else { console.warn(`[DataStore] Metadata record already existed in DB for ID: ${uploadId}.`); }

				await transaction.commit();

			} else {
				if (!originalFilename) console.warn(`[DataStore] Could not save metadata to DB. Original filename ('name') missing in file.metadata.`);
				if (!uploadId) console.warn(`[DataStore] Could not save metadata to DB. Upload ID missing from file object.`);
				if (transaction) { await transaction.rollback(); }
			}
		} catch (dbError) {
			console.error(`[DataStore] Error during DB transaction for ID ${uploadId}:`, dbError);
			if (transaction) {
				try { await transaction.rollback(); console.log('[DataStore] Rolled back transaction due to error.'); }
				catch (rollbackError) { console.error('[DataStore] Error rolling back transaction:', rollbackError); }
			}
		}

		const createdUpload = await super.create(file);
		return createdUpload;
	}
}
// --- End Custom DataStore ---


// --- Create Tus Components ---
const customFileStore = new FileStoreWithDbMetadata({ directory: absoluteUploadDir });
const tusServer = new Server({
	path: tusPath,
	datastore: customFileStore, // Use the custom datastore
});

// --- Event Handling ---
interface TusFile { id: string; size: number; offset: number; metadata: Record<string, string>; creation_date?: string; }
interface TusEvent { file?: TusFile; req?: http.IncomingMessage; res?: http.ServerResponse; method?: string; url?: string; headers?: http.IncomingHttpHeaders; }

// --- REMOVED POST_CREATE Handler (Logic moved to DataStore) ---

// --- Modified POST_FINISH Handler (Removed DB cleanup) ---
tusServer.on(EVENTS.POST_FINISH, async (event: TusEvent) => {
	console.log(`[EVENT:POST_FINISH] Handler invoked.`);
	const requestUrl = event.url;
	if (!requestUrl) { console.error(`[EVENT:POST_FINISH] Error: Could not determine upload URL from event.`); return; }

	const urlParts = requestUrl.split(tusPath);
	let uploadId = urlParts[1];
	if (uploadId && uploadId.startsWith('/')) { uploadId = uploadId.substring(1); }

	if (!uploadId) { console.error(`[EVENT:POST_FINISH] Error: Could not parse upload ID from URL: ${requestUrl}`); return; }

	console.log(`[EVENT:POST_FINISH] ✅ Upload complete for ID (cleaned): ${uploadId}.`);
	let uploadRecord: UploadModel | null = null;
	try {
		console.log(`[Rename] Looking up metadata in DB for ID ${uploadId}...`);
		uploadRecord = await UploadModel.findByPk(uploadId);

		let originalFilename: string | undefined;
		if (uploadRecord) {
			const recordData = uploadRecord.get({ plain: true });
			console.log(`[Rename] Found record dataValues:`, recordData);
			originalFilename = recordData.originalFilename;
		} else {
			console.log(`[Rename] Result from findByPk for ID ${uploadId}: Record NOT found (null)`);
		}

		console.log(`[Rename] Filename extracted from recordData: ${originalFilename}`);

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
				} catch (renameError: any) { console.error(`[Rename] Error during rename process:`, renameError); /* Don't return here, allow finally block */ }
			} else { console.warn(`[Rename] Original filename "${originalFilename}" sanitized to an empty string. File will not be renamed.`); }
		} else {
			console.log(`[Rename] No metadata record OR no originalFilename found in DB for ID ${uploadId}. File will not be renamed.`);
		}

	} catch (dbError) { console.error(`[Rename] Error querying DB for ID ${uploadId}:`, dbError);
	} finally {
		// --- REMOVED DB Cleanup from finally block ---
		console.log(`[Rename][Finally] Finished processing POST_FINISH for ID ${uploadId}. DB record NOT deleted here.`);
		// --- End Removal ---
	}
});

// --- Modified POST_TERMINATE Handler (Removed DB cleanup) ---
tusServer.on(EVENTS.POST_TERMINATE, async (event: TusEvent) => {
	let uploadId: string | undefined;
	if (event.file?.id) { uploadId = event.file.id; }
	else if (event.url) { const urlParts = event.url.split(tusPath); uploadId = urlParts[1]; if (uploadId && uploadId.startsWith('/')) { uploadId = uploadId.substring(1); } }

	if (uploadId) {
		console.log(`[EVENT:POST_TERMINATE] ⛔ Upload terminated unexpectedly for ID: ${uploadId}.`);
		// --- REMOVED DB Cleanup ---
		console.log(`[EVENT:POST_TERMINATE] DB record for terminated upload ${uploadId} NOT deleted here.`);
		// --- End Removal ---
	} else { console.error(`[EVENT:POST_TERMINATE] Error: Received POST_TERMINATE event but could not determine upload ID.`); }
});

tusServer.on('error' as any, (error: Error, event?: { req: http.IncomingMessage, res: http.ServerResponse }) => {
	const reqId = event?.req?.headers['x-request-id'] || 'N/A';
	console.error(`[EVENT:tusServer.error] Tus Server Error (Req ID: ${reqId})`, error);
});


// --- Create HTTP Server ---
const httpServer = http.createServer((req, res) => {
	corsMiddleware(req, res, (err?: any) => {
		if (err) {
			console.error("[CORS Middleware Error]", err);
			if (!res.headersSent) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Internal Server Error (CORS Configuration)"); }
			else if (!res.writableEnded) { res.end(); }
			return;
		}
		const reqUrl = req.url ?? '';
		if (reqUrl.startsWith(tusPath)) { tusServer.handle(req, res); return; }
		if (reqUrl === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`Welcome! Tus endpoint is at ${tusPath}`); return; }
		if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
		else if (!res.writableEnded) { res.end(); }
	});
});

// --- Function to Start HTTP Server ---
function startHttpServer() {
	httpServer.listen(port, hostname, () => {
		console.log(`🚀 tus server (ESM) listening at http://${hostname}:${port}${tusPath}`);
		console.warn(`⚠️ Warning: Server is running without a file locker.`);
		console.info(`ℹ️  Using default server-generated upload IDs.`);
		console.info(`✅ CORS enabled via middleware for origin: ${ALLOWED_ORIGIN}`);
		console.info(`💾 Storing upload metadata in PostgreSQL via Custom DataStore.`);
		console.info(`📝 Files will be renamed on completion using 'id-sanitizedOriginalName' format.`);
		console.info(`⏰ Database cleanup job scheduled.`); // Added info
	});
}

// --- NEW: Schedule Database Cleanup ---
function scheduleDatabaseCleanup() {
	// Schedule to run, for example, every day at 2:00 AM
	// Cron format: second minute hour day-of-month month day-of-week
	// '0 2 * * *' means 2:00 AM daily
	cron.schedule('0 2 * * *', async () => {
		console.log('[Cron Cleanup] Running scheduled job to delete old upload metadata...');
		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

		try {
			const deletedCount = await UploadModel.destroy({
				where: {
					// --- Use the correct column name 'createdAt' ---
					createdAt: { // This should now work with the updated interface
						[Op.lt]: twentyFourHoursAgo // Op.lt means "less than"
					}
					// --- End fix ---
				}
			});
			console.log(`[Cron Cleanup] Deleted ${deletedCount} old metadata records.`);
		} catch (error) {
			console.error('[Cron Cleanup] Error during scheduled cleanup:', error);
		}
	}, {
		scheduled: true,
		timezone: "Asia/Kolkata" // Optional: Specify your timezone
	});

	console.log(`[Cron Cleanup] Job scheduled to run daily at 2:00 AM.`);
}
// --- End Schedule Database Cleanup ---


// --- Initialize App (DB connection, then start server & schedule job) ---
initializeApp(); // Call the main initialization function

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
	console.log('\n[Shutdown] Caught SIGINT, shutting down gracefully...');
	// Optional: Stop cron jobs if needed (node-cron doesn't explicitly require it for process exit)
	httpServer.close(async () => {
		console.log('[Shutdown] HTTP server closed.');
		try { await sequelize.close(); console.log('[Shutdown] Database connection closed.'); }
		catch (dbCloseError) { console.error('[Shutdown] Error closing database connection:', dbCloseError); }
		finally { process.exit(0); }
	});
});
