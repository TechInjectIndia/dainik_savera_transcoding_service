import { BaseHandler } from './BaseHandler.js';
import { type CancellationContext } from '@tus/utils';
export declare class PatchHandler extends BaseHandler {
    /**
     * Write data to the DataStore and return the new offset.
     */
    send(req: Request, context: CancellationContext, headers?: import("undici-types").Headers): Promise<import("undici-types").Response>;
}
//# sourceMappingURL=PatchHandler.d.ts.map