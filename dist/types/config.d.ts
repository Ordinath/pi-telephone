import type { Config } from './protocol.js';
export declare const DEFAULT_CONFIG: Config;
export declare function homePath(home?: string): string;
export declare function inboxPath(home?: string): string;
export declare function paths(home?: string): {
    home: string;
    socket: string;
    socketPath: string;
    lock: string;
    config: string;
    log: string;
};
export declare function prepareHome(home?: string): Promise<void>;
export declare function clientSocketPath(home?: string): Promise<string>;
export declare function isFsError(error: unknown, code: string): boolean;
export declare function loadConfig(home?: string): Promise<Config>;
export declare function saveConfig(home: string | undefined, config: Config): Promise<void>;
export declare function log(home: string | undefined, level: string, message: string): Promise<void>;
