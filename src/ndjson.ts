import type { Socket } from 'node:net';
export const MAX_LINE_BYTES = 1024 * 1024;
export function writeFrame(socket: Socket, frame: unknown): void {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('NDJSON line exceeds 1 MiB');
  socket.write(`${line}\n`);
}
export function readFrames(socket: Socket, receive: (frame: unknown) => void): void {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_LINE_BYTES) { socket.destroy(); return; }
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try { receive(JSON.parse(line.toString('utf8'))); }
      catch { socket.destroy(); return; }
    }
    if (pending.length > MAX_LINE_BYTES) socket.destroy();
  });
}
