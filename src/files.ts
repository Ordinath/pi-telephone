import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, sep } from 'node:path';
import { inboxPath } from './config.js';

function bytePrefix(text: string, max: number): string {
  let result = '';
  for (const char of text) { if (Buffer.byteLength(result + char) > max) break; result += char; }
  return result;
}
export function safeFileName(name: string): string {
  const clean = name.split(/[/\\]/).at(-1)!.normalize('NFC').replace(/[^\p{L}\p{N} ._()+-]/gu, '_')
    .replace(/_+/g, '_').replace(/ +/g, ' ').replace(/^[. _]+|[. ]+$/g, '');
  const ext = bytePrefix(extname(clean), 99);
  const stem = clean.slice(0, clean.length - extname(clean).length);
  return (bytePrefix(stem, 100 - Buffer.byteLength(ext)) || (ext ? 'f' : '')) + ext || 'file';
}
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(input => {
    const name = safeFileName(input), ext = extname(name), stem = name.slice(0, name.length - ext.length);
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) {
      const suffix = `-${n}${bytePrefix(ext, 99 - Buffer.byteLength(`-${n}`))}`;
      unique = (bytePrefix(stem, 100 - Buffer.byteLength(suffix)) || 'f') + suffix;
    }
    used.add(unique.toLowerCase());
    return unique;
  });
}
const extensions: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', log: 'text/plain',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip',
};
export function detectMime(head: Buffer, name: string): string {
  const hex = head.toString('hex'), text = head.toString('latin1');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (/^GIF8[79]a/.test(text)) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.startsWith('%PDF-')) return 'application/pdf';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (text.startsWith('OggS')) return 'audio/ogg';
  if (text.startsWith('fLaC')) return 'audio/flac';
  if (text.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (text.slice(4, 8) === 'ftyp') return ['M4A ', 'M4B '].includes(text.slice(8, 12)) ? 'audio/mp4' : 'video/mp4';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (['504b0304', '504b0506', '504b0708'].some(magic => hex.startsWith(magic))) return 'application/zip';
  return extensions[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}
export function isImageMime(mime: string): boolean { return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime); }
export function formatBytes(n: number): string {
  return n < 1000 ? `${n} B` : n < 1000000 ? `${(n / 1000).toFixed(1)} KB` : n < 1000000000 ? `${(n / 1000000).toFixed(1)} MB` : `${(n / 1000000000).toFixed(1)} GB`;
}
export async function hashFile(path: string): Promise<{ size: number; sha256: string; head: Buffer }> {
  const hash = createHash('sha256');
  let size = 0, head = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
    if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
  }
  return { size, sha256: hash.digest('hex'), head };
}
export async function inboxFile(path: string) {
  const root = await realpath(inboxPath()).catch(() => { throw new Error(`Telephone inbox is not available: ${inboxPath()}`); });
  const actual = await realpath(path);
  if (!actual.startsWith(root + sep)) throw new Error(`File must be inside the telephone inbox: ${root}`);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`Not a regular file: ${actual}`);
  const file = await open(actual, 'r');
  const head = Buffer.alloc(64);
  let bytesRead: number;
  try { ({ bytesRead } = await file.read(head, 0, head.length, 0)); } finally { await file.close(); }
  return { path: actual, name: basename(actual), size: info.size, mime: detectMime(head.subarray(0, bytesRead), actual) };
}
