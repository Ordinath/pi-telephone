import * as agent from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import type { ExtensionAPI, MessageRenderer } from '@earendil-works/pi-coding-agent';

const imageComponents = new WeakMap<object, { component: tui.Image; maxWidthCells: number }>();

export function createTelephoneRenderer(pi: Partial<Pick<ExtensionAPI, 'getSettings'>>): MessageRenderer {
  return (message, options, theme) => {
    try {
      if (typeof message.content === 'string') return;
      const images = message.content.filter(block => block.type === 'image');
      if (!images.length) return;
      const { Box, Container, Image, Markdown, Spacer, Text, getCapabilities, imageFallback, getImageDimensions } = tui;
      const { getMarkdownTheme } = agent;
      if ([Box, Container, Image, Markdown, Spacer, Text, getCapabilities, imageFallback, getImageDimensions, getMarkdownTheme]
        .some(value => typeof value !== 'function')) return;
      const settings = typeof pi.getSettings === 'function' ? pi.getSettings() : undefined;
      const terminal = settings?.terminal;
      const showImages = terminal?.showImages ?? true;
      const width = terminal?.imageWidthCells;
      const imageWidthCells = typeof width === 'number' && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 60;
      const color = (text: string) => theme.fg('customMessageText', text);
      const container = new Container();
      const box = new Box(1, 1, text => theme.bg('customMessageBg', text));
      box.setPaddingX(options.outputPad);
      box.addChild(new Text(theme.fg('customMessageLabel', '\x1b[1m[telephone]\x1b[22m'), 0, 0));
      box.addChild(new Spacer(1));
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      box.addChild(new Markdown(text, 0, 0, { ...getMarkdownTheme(), codeBlockIndent: settings?.markdown?.codeBlockIndent ?? '  ' }, { color }));
      container.addChild(box);
      const canShowImages = getCapabilities().images && showImages;
      for (const image of images) {
        if (canShowImages) {
          container.addChild(new Spacer(1));
          const cached = imageComponents.get(image);
          const component = cached?.maxWidthCells === imageWidthCells ? cached.component
            : new Image(image.data, image.mimeType, { fallbackColor: color }, { maxWidthCells: imageWidthCells });
          imageComponents.set(image, { component, maxWidthCells: imageWidthCells });
          container.addChild(component);
        } else {
          box.addChild(new Text(color(imageFallback(image.mimeType, getImageDimensions(image.data, image.mimeType) ?? undefined)), 0, 0));
        }
      }
      return container;
    } catch { return; }
  };
}
