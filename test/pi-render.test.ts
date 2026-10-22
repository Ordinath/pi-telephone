import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { CustomMessageComponent, getMarkdownTheme, initTheme, type MessageRenderer } from '@earendil-works/pi-coding-agent';
import { Container, Image, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { createTelephoneRenderer } from '../pi/render.js';

function png(): string {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

initTheme('dark');
afterEach(() => resetCapabilitiesCache());
const image = { type: 'image' as const, data: png(), mimeType: 'image/png' };
const content = [{ type: 'text' as const, text: 'Received **attached** image' }, image, { type: 'text' as const, text: 'Second text block' }];
const message = (content: Parameters<MessageRenderer>[0]['content']): Parameters<MessageRenderer>[0] => ({
  role: 'custom', customType: 'telephone', content: typeof content === 'string' ? content : content.map(block => ({ ...block })), display: true, timestamp: Date.now(),
});
const options = { expanded: false, outputPad: 3 };
const render = createTelephoneRenderer({ getSettings: () => ({}) });
const imageEscape = /\x1b\]1337;File=|\x1b_G/;
function lines(renderer = render, blocks = content): string[] {
  const component = renderer(message(blocks), options, theme);
  assert.ok(component);
  return component.render(80);
}

function assertText(output: string[]): void {
  assert.ok(output.some(line => line.includes('[telephone]')));
  assert.ok(output.some(line => line.includes('Received ') && line.includes('attached') && line.includes(' image')));
  assert.ok(output.some(line => line.includes('Second text block')));
}

test('telephone leaves string and image-free messages to the default renderer', () => {
  assert.equal(render(message('Text only'), options, theme), undefined);
  assert.equal(render(message([{ type: 'text', text: 'Text only' }]), options, theme), undefined);
  assert.equal(render(message([]), options, theme), undefined);
});

test('telephone draws iTerm2 images outside the default-style text box', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const output = lines();
  assertText(output);
  const imageLine = output.findIndex(line => line.includes('\x1b]1337;File='));
  assert.ok(imageLine > output.findIndex(line => line.includes('Second text block')));
  assert.ok(!output[imageLine].includes('\x1b[48;'));
  const defaultLines = new CustomMessageComponent(message(content), undefined, undefined, options.outputPad).render(80).slice(1);
  assert.deepEqual(output.slice(0, defaultLines.length), defaultLines);
});

test('telephone matches default code block rendering with a custom indent', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const markdown = { codeBlockIndent: '      ' };
  let settingsReads = 0;
  const renderer = createTelephoneRenderer({ getSettings: () => { settingsReads++; return { markdown }; } });
  const blocks = [{ type: 'text' as const, text: '```text\nIndented code\n```' }, image];
  const defaultLines = new CustomMessageComponent(message(blocks), undefined, { ...getMarkdownTheme(), ...markdown }, options.outputPad).render(80).slice(1);
  assert.deepEqual(lines(renderer, blocks).slice(0, defaultLines.length), defaultLines);
  assert.equal(settingsReads, 1);
});

test('telephone reuses image components until their width changes', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  const terminal = { imageWidthCells: 24 };
  const renderer = createTelephoneRenderer({ getSettings: () => ({ terminal }) });
  const entry = message(content);
  const imageComponent = () => {
    const component = renderer(entry, options, theme);
    assert.ok(component instanceof Container);
    const image = component.children.find(child => child instanceof Image);
    assert.ok(image);
    return image;
  };
  const first = imageComponent();
  assert.equal(imageComponent(), first);
  terminal.imageWidthCells = 30;
  const resized = imageComponent();
  assert.notEqual(resized, first);
  assert.equal(imageComponent(), resized);
});

test('telephone draws PNG images with the Kitty protocol', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  const output = lines();
  assertText(output);
  assert.ok(output.some(line => line.includes('\x1b_G')));
});

test('telephone shows a text placeholder when the terminal cannot draw images', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const output = lines();
  assertText(output);
  assert.ok(output.every(line => !imageEscape.test(line)));
  assert.ok(output.some(line => line.includes('[Image: [image/png] 1x1]')));
});

test('telephone shows a text placeholder when showImages is false', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const output = lines(createTelephoneRenderer({ getSettings: () => ({ terminal: { showImages: false } }) }));
  assertText(output);
  assert.ok(output.every(line => !imageEscape.test(line)));
  assert.ok(output.some(line => line.includes('[Image: [image/png] 1x1]')));
});

test('telephone uses default image settings on older Pi without getSettings', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const output = lines(createTelephoneRenderer({}));
  assertText(output);
  assert.ok(output.some(line => line.includes('\x1b]1337;File=') && line.includes('width=60;')));
});

test('telephone reads image settings on each render and rejects invalid widths', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const terminal = { showImages: true, imageWidthCells: 24 };
  const renderer = createTelephoneRenderer({ getSettings: () => ({ terminal }) });
  assert.ok(lines(renderer).some(line => line.includes('width=24;')));
  for (const width of [NaN, Infinity, -Infinity]) {
    terminal.imageWidthCells = width;
    assert.ok(lines(renderer).some(line => line.includes('width=60;')));
  }
  terminal.imageWidthCells = 1;
  assert.ok(lines(renderer).some(line => line.includes('width=1;')));
  terminal.showImages = false;
  assert.ok(lines(renderer).some(line => line.includes('[Image: [image/png] 1x1]')));
});

test('telephone clamps and floors image widths like Pi', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  const terminal = { imageWidthCells: 0.5 };
  const renderer = createTelephoneRenderer({ getSettings: () => ({ terminal }) });
  for (const [width, expected] of [[0, 1], [-1, 1], [0.5, 1], [24.6, 24]]) {
    terminal.imageWidthCells = width;
    assert.ok(lines(renderer).some(line => line.includes(`width=${expected};`)));
  }
});

test('telephone renders every image or its placeholder', () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
  assert.equal(lines(render, [...content, image]).filter(line => imageEscape.test(line)).length, 2);
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  assert.equal(lines(render, [...content, image]).filter(line => line.includes('[Image: [image/png] 1x1]')).length, 2);
});

test('telephone falls back to the default renderer when rendering throws', () => {
  const renderer = createTelephoneRenderer({ getSettings: () => { throw new Error('Settings unavailable'); } });
  assert.equal(renderer(message(content), options, theme), undefined);
});
