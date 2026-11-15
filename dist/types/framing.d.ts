import type { InboundMessage } from './protocol.js';
export declare function renderInbound(message: InboundMessage, opts: {
    replyHint: string;
    ownerLogin?: string;
    filesNote?: string;
}): string;
