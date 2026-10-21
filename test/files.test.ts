import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMime, safeFileName, uniqueNames } from '../src/files.js';

test('safeFileName strips paths and unsafe characters, preserves Unicode and caps UTF-8 bytes with an extension', () => {
  assert.equal(safeFileName('/tmp/..\\Фото.png'), 'Фото.png');
  assert.equal(safeFileName('.. __a\x00;$(x)`<>|?*  b.. '), 'a_(x)_ b');
  assert.equal(safeFileName('е\u0308.png'), 'ё.png');
  const long = safeFileName('я'.repeat(100) + '.png');
  assert.ok(Buffer.byteLength(long) <= 100);
  assert.ok(long.endsWith('.png'));
  assert.equal(safeFileName('... __ '), 'file');
  assert.equal(safeFileName(''), 'file');
});

test('uniqueNames numbers duplicates without collisions', () => {
  assert.deepEqual(uniqueNames(['photo.png', 'photo.png', 'photo.png', 'photo-2.png', 'README', 'README']),
    ['photo.png', 'photo-2.png', 'photo-3.png', 'photo-2-2.png', 'README', 'README-2']);
});

test('uniqueNames compares names case-insensitively', () => {
  assert.deepEqual(uniqueNames(['Photo.png', 'photo.png', 'PHOTO.PNG', 'photo-2.PNG', 'README', 'readme']),
    ['Photo.png', 'photo-2.png', 'PHOTO-3.PNG', 'photo-2-2.PNG', 'README', 'readme-2']);
});

test('detectMime prefers PNG, JPEG, WAV, MP3 and M4A magic, then known extensions', () => {
  assert.equal(detectMime(Buffer.from('89504e470d0a1a0a', 'hex'), 'wrong.bin'), 'image/png');
  assert.equal(detectMime(Buffer.from('ffd8ff', 'hex'), 'wrong.png'), 'image/jpeg');
  assert.equal(detectMime(Buffer.from('RIFFxxxxWAVE'), 'wrong.bin'), 'audio/wav');
  assert.equal(detectMime(Buffer.from('ID3test'), 'wrong.bin'), 'audio/mpeg');
  assert.equal(detectMime(Buffer.from('\0\0\0\x18ftypM4A '), 'wrong.bin'), 'audio/mp4');
  assert.equal(detectMime(Buffer.from([0, 1, 2, 3]), 'unknown.bin'), 'application/octet-stream');
  assert.equal(detectMime(Buffer.from([0, 1, 2, 3]), 'known.txt'), 'text/plain');
});
