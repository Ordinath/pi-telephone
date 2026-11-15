import type { Socket } from 'node:net';
export declare const MAX_LINE_BYTES: number;
export declare function writeFrame(socket: Socket, frame: unknown): void;
export declare function readFrames(socket: Socket, receive: (frame: unknown) => void): void;
