import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TelephoneError } from '../protocol.js';

export interface HttpInput { method: string; url: URL; sourceIP: string; fromPort?: number; body: unknown }
export interface HttpOutput { status?: number; body: unknown }
const errorStatus: Record<string, number> = {
  forbidden: 403, not_trusted: 403, not_reachable: 404, busy_waiting: 409,
  too_large: 413, rate_limited: 429, delivery_failed: 502, invalid_id: 400, proto_mismatch: 400, invalid_request: 400,
};
export function normalizedIP(ip: string): string { return ip.replace(/^::ffff:/, ''); }
export function networkServer(maxBytes: number, handle: (input: HttpInput) => Promise<HttpOutput>): Server {
  const server = createServer((req, res) => {
    const timer = setTimeout(() => { req.destroy(); res.destroy(); }, 10000);
    res.on('close', () => clearTimeout(timer));
    void serve(req, res, maxBytes, handle);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
async function serve(req: IncomingMessage, res: ServerResponse, maxBytes: number, handle: (input: HttpInput) => Promise<HttpOutput>): Promise<void> {
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new TelephoneError('too_large');
      chunks.push(chunk);
    }
    let body: unknown;
    if (size) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new TelephoneError('invalid_request'); }
    }
    const header = req.headers['x-telephone-from-port'];
    const port = typeof header === 'string' ? Number(header) : undefined;
    const result = await handle({
      method: req.method ?? '', url: new URL(req.url ?? '/', 'http://exchange'),
      sourceIP: normalizedIP(req.socket.remoteAddress ?? ''),
      fromPort: port && Number.isInteger(port) && port <= 65535 ? port : undefined, body,
    });
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    const code = error instanceof TelephoneError ? error.code : 'invalid_request';
    res.writeHead(errorStatus[code] ?? 400, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: code, message: error instanceof TelephoneError ? error.message : 'Invalid request' }));
    req.resume();
  }
}
export function peerRequest<T>(options: {
  host: string; port: number; path: string; timeout: number; fromPort: number;
  localAddress?: string; body?: unknown; maxBytes?: number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({
      host: options.host, port: options.port, path: options.path, method: body === undefined ? 'GET' : 'POST',
      localAddress: options.localAddress, agent: false,
      headers: { 'content-type': 'application/json', 'x-telephone-from-port': String(options.fromPort), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 1024 * 1024)) { req.destroy(new TelephoneError('unreachable', 'Peer response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new TelephoneError(typeof value.error === 'string' ? value.error : 'unreachable', value.message));
          else resolve(value);
        } catch { reject(new TelephoneError('unreachable', 'Invalid peer response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new TelephoneError('unreachable', 'Peer request timed out')), options.timeout);
    req.on('error', error => { clearTimeout(timer); reject(error instanceof TelephoneError ? error : new TelephoneError('unreachable', error.message)); });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
export async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
