import { Transform } from 'node:stream';
import { ERRORS } from '../constants.js';
// TODO: create HttpError and use it everywhere instead of throwing objects
export class MaxFileExceededError extends Error {
    status_code;
    body;
    constructor() {
        super(ERRORS.ERR_MAX_SIZE_EXCEEDED.body);
        this.status_code = ERRORS.ERR_MAX_SIZE_EXCEEDED.status_code;
        this.body = ERRORS.ERR_MAX_SIZE_EXCEEDED.body;
        Object.setPrototypeOf(this, MaxFileExceededError.prototype);
    }
}
export class StreamLimiter extends Transform {
    maxSize;
    currentSize = 0;
    constructor(maxSize) {
        super();
        this.maxSize = maxSize;
    }
    _transform(chunk, encoding, callback) {
        this.currentSize += chunk.length;
        if (this.currentSize > this.maxSize) {
            callback(new MaxFileExceededError());
        }
        else {
            callback(null, chunk);
        }
    }
}
//# sourceMappingURL=StreamLimiter.js.map