/**
 * Memory based configstore.
 * Used mostly for unit tests.
 */
export class MemoryKvStore {
    data = new Map();
    async get(key) {
        return this.data.get(key);
    }
    async set(key, value) {
        this.data.set(key, value);
    }
    async delete(key) {
        this.data.delete(key);
    }
    async list() {
        return [...this.data.keys()];
    }
}
//# sourceMappingURL=MemoryKvStore.js.map