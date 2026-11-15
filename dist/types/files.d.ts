export declare function safeFileName(name: string): string;
export declare function uniqueNames(names: string[]): string[];
export declare function detectMime(head: Buffer, name: string): string;
export declare function isImageMime(mime: string): boolean;
export declare function formatBytes(n: number): string;
export declare function hashFile(path: string): Promise<{
    size: number;
    sha256: string;
    head: Buffer;
}>;
export declare function inboxFile(path: string): Promise<{
    path: string;
    name: string;
    size: number;
    mime: string;
}>;
