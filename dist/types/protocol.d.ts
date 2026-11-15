export declare const PROTO_VERSION = 1;
export declare const FEATURES: string[];
export declare const CLIENT_FEATURES: string[];
export declare const VERSION: string;
export type Harness = 'pi' | 'claude-code' | 'cli' | 'pi-fleet';
export declare function wireHarness(harness: string, features: readonly string[] | undefined): string;
export type SessionStatus = 'idle' | 'busy';
export interface MachineIdentity {
    fqdn: string;
    short: string;
    login: string;
    displayName?: string;
    ips: string[];
}
export interface Session {
    key: string;
    name: string;
    harness: Harness;
    cwd: string;
    hostPid: number;
}
export interface SessionPatch {
    name?: string;
    allow?: string[];
    status?: SessionStatus;
}
export interface Config {
    port: number;
    trustedUsers: string[];
    tailscaleCli: string | null;
    maxMessageBytes: number;
    maxFileBytes: number;
    maxFiles: number;
    inboxMaxBytes: number;
    inboxDays: number;
}
export interface TrustPatch {
    add?: string[];
    remove?: string[];
}
export interface ExchangeInfo {
    version: string;
    proto: number;
    /** The exchange's process id; exchanges before 0.3.2 omit it. */
    pid?: number;
    features?: string[];
    limits?: {
        maxFileBytes: number;
        maxFiles: number;
    };
    machine: Pick<MachineIdentity, 'fqdn' | 'short' | 'login'>;
    listening: {
        address: string;
        port: number;
    } | null;
}
export interface DirectoryEntry {
    address: string;
    session: string;
    machine: string;
    fqdn: string;
    harness: string;
    status: SessionStatus;
    cwd?: string;
    local: boolean;
    self: boolean;
}
export interface Directory {
    entries: DirectoryEntry[];
    warnings: string[];
}
export interface FileInfo {
    name: string;
    size: number;
    sha256: string;
    mime: string;
}
export interface ReceivedFile extends FileInfo {
    path: string;
}
export interface InboundMessage {
    files?: ReceivedFile[];
    id: string;
    from: {
        address: string;
        session: string;
        machine: string;
        fqdn: string;
        login: string;
        displayName?: string;
        harness?: string;
        local: boolean;
    };
    text: string;
    expectReply: boolean;
    replyTo?: string;
    isReplyToOwnCall: boolean;
    sentAt: string;
}
export interface SendInput {
    id?: string;
    to?: string;
    text: string;
    replyTo?: string;
    files?: string[];
}
export interface SendResult {
    id: string;
    status: 'delivered';
    to: string;
    inferredReplyTo?: string;
    files?: FileInfo[];
}
export interface Ack {
    t: 'ack';
    id: string;
    accepted: boolean;
    reason?: string;
}
export type Request = {
    rid: string;
} & ({
    t: 'hello';
    proto: number;
    client: {
        harness: Harness;
        version: string;
        pid: number;
        features?: string[];
    };
} | {
    t: 'register';
    session: Session;
    allow: string[];
} | ({
    t: 'update';
} & SessionPatch) | {
    t: 'unregister' | 'directory' | 'getConfig' | 'shutdown';
} | ({
    t: 'send';
    id: string;
    expectReply?: boolean;
    files?: {
        path: string;
    }[];
} & Omit<SendInput, 'files'>) | {
    t: 'cancelWait';
    id: string;
} | ({
    t: 'setTrustedUsers';
} & TrustPatch));
export type ClientFrame = Request | Ack;
export type ServerFrame = ({
    t: 'ok';
    rid: string;
} & Record<string, unknown>) | {
    t: 'error';
    rid: string;
    code: string;
    message: string;
} | {
    t: 'deliver';
    message: InboundMessage;
};
export interface NetworkDelivery {
    files?: FileInfo[];
    proto: number;
    id: string;
    from: {
        session: string;
        harness: string;
    };
    fromPort: number;
    to: {
        session: string;
    };
    text: string;
    expectReply: boolean;
    replyTo?: string;
    sentAt: string;
}
export interface NetworkHello {
    features?: string[];
    limits?: {
        maxFileBytes: number;
        maxFiles: number;
    };
    proto: number;
    version: string;
    machine: ExchangeInfo['machine'];
}
export interface NetworkDirectory {
    sessions: {
        session: string;
        harness: string;
        status: SessionStatus;
        cwd?: string;
    }[];
}
export declare class TelephoneError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
export declare function isUuid(id: unknown): id is string;
