import type { MediaPayload } from '../context/workbench-protocol';

/** Host and webview use the same capabilities when offering media operations. */
const CAPABILITIES = {
    sprite: { palette: true, zoom: true, remap: true, compare: true, export: 'png' },
    voxel: { palette: true, zoom: true, remap: true, compare: true, export: 'png' },
    image: { palette: false, zoom: true, remap: false, compare: true, export: 'png' },
    audio: { palette: false, zoom: false, remap: false, compare: false, export: 'audio' },
    palette: { palette: false, zoom: false, remap: false, compare: true, export: 'png' },
} as const;

export function mediaCapabilities(kind: MediaPayload['kind']) {
    return CAPABILITIES[kind];
}
