import type { Channel } from '@lcm/shared';
import type { ChannelAdapter } from './types.js';
import { lineAdapter } from './line.js';
import { chatworkAdapter } from './chatwork.js';
import { gmailAdapter } from './gmail.js';

const adapters: Record<Channel, ChannelAdapter> = { line: lineAdapter, chatwork: chatworkAdapter, gmail: gmailAdapter };

export function adapterFor(channel: Channel): ChannelAdapter {
  return adapters[channel];
}

/** テスト用に差し替え */
export function setAdapter(channel: Channel, adapter: ChannelAdapter) {
  adapters[channel] = adapter;
}
