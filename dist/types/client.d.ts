import { EventEmitter } from 'node:events';
import { type Config, type Directory, type ExchangeInfo, type Harness, type InboundMessage, type SendInput, type SendResult, type Session, type SessionPatch, type TrustPatch } from './protocol.js';
export { TelephoneError } from './protocol.js';
export interface ClientOptions {
    harness: Harness;
    version: string;
    onMessage: (message: InboundMessage) => Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    home?: string;
    exchangeEntry?: string;
    /** What this host can receive; default ['files']. Without 'files' the exchange refuses file sends to it. */
    features?: string[];
    /** Pass replies to this client's own asks to onMessage too; the ask returns only after resolveReply(message). */
    deferReplies?: boolean;
}
export declare class TelephoneClient extends EventEmitter {
    private readonly opts;
    private socket?;
    private connecting?;
    private info?;
    private closed;
    private wasConnected;
    private reconnectTimer?;
    private reconnectDelay;
    private registration?;
    private requests;
    private replies;
    private readonly home;
    constructor(opts: ClientOptions);
    connect(): Promise<ExchangeInfo>;
    private ensureExchange;
    private establish;
    private scheduleReconnect;
    private request;
    private receive;
    private wireSession;
    /** With deferReplies: true when an ask of this client waits for message id `id`. */
    waiting(id: string): boolean;
    /** With deferReplies: hand a reply to the ask that waits for it; false when none waits. */
    resolveReply(message: InboundMessage): boolean;
    register(session: Session, allow?: string[]): Promise<string>;
    update(patch: SessionPatch): Promise<string>;
    unregister(): Promise<void>;
    directory(): Promise<Directory>;
    private fileInputs;
    send(input: SendInput): Promise<SendResult>;
    /** `id` lets the host know the call's message id before the reply arrives; it must be a fresh UUID. */
    ask(input: {
        id?: string;
        to: string;
        text: string;
        timeoutMs: number;
        signal?: AbortSignal;
        files?: string[];
    }): Promise<{
        sent: SendResult;
        reply: InboundMessage;
    }>;
    getConfig(): Promise<{
        config: Config;
        owner: string;
        inboxBytes: number;
    }>;
    setTrustedUsers(patch: TrustPatch): Promise<{
        trustedUsers: string[];
    }>;
    shutdownExchange(): Promise<void>;
    close(): Promise<void>;
}
