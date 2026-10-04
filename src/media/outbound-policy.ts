import type { MediaKind } from './validation.js';

export function mediaSupportsCaption(kind:MediaKind):boolean {
  return kind === 'image' || kind === 'document' || kind === 'video';
}

// Provider capabilities are evaluated separately; a saved caption must never be silently discarded.
export function mediaCaptionAllowed(kind:MediaKind,caption:string):boolean {
  return caption.length <= 1024 && (mediaSupportsCaption(kind) || caption.length === 0);
}
