import { BaseHandler } from './BaseHandler.js';
import { type DataStore, type CancellationContext } from '@tus/utils';
import type { ServerOptions, WithRequired } from '../types.js';
export declare class PostHandler extends BaseHandler {
    options: WithRequired<ServerOptions, 'namingFunction'>;
    constructor(store: DataStore, options: ServerOptions);
    /**
     * Create a file in the DataStore.
     */
    send(req: Request, context: CancellationContext, headers?: import("undici-types").Headers): Promise<import("undici-types").Response>;
}
//# sourceMappingURL=PostHandler.d.ts.map