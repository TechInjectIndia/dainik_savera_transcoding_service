import EventEmitter from 'node:events';
import { Upload } from './Upload.js';
export class DataStore extends EventEmitter {
    extensions = [];
    hasExtension(extension) {
        return this.extensions?.includes(extension);
    }
    /**
     * Called in POST requests. This method just creates a
     * file, implementing the creation extension.
     *
     * http://tus.io/protocols/resumable-upload.html#creation
     */
    async create(file) {
        return file;
    }
    /**
     * Called in DELETE requests. This method just deletes the file from the store.
     * http://tus.io/protocols/resumable-upload.html#termination
     */
    async remove(id) { }
    /**
     * Called in PATCH requests. This method should write data
     * to the DataStore file, and possibly implement the
     * concatenation extension.
     *
     * http://tus.io/protocols/resumable-upload.html#concatenation
     */
    async write(stream, id, offset) {
        return 0;
    }
    /**
     * Called in HEAD requests. This method should return the bytes
     * writen to the DataStore, for the client to know where to resume
     * the upload.
     */
    async getUpload(id) {
        return new Upload({
            id,
            size: 0,
            offset: 0,
            storage: { type: 'datastore', path: '' },
        });
    }
    /**
     * Called in PATCH requests when upload length is known after being defered.
     */
    async declareUploadLength(id, upload_length) { }
    /**
     * Returns number of expired uploads that were deleted.
     */
    async deleteExpired() {
        return 0;
    }
    getExpiration() {
        return 0;
    }
}
//# sourceMappingURL=DataStore.js.map