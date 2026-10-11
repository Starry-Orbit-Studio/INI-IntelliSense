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

/** Only offer house colors when a sprite drawer or a voxel in this preview uses them. */
export function mediaUsesRemap(media: MediaPayload): boolean {
    return (
        media.kind === 'voxel' ||
        (media.kind === 'sprite' &&
            (media.scene
                ? media.scene.layers.some((layer) => !!layer.voxel || (layer.remap ?? layer.media?.remap) === true)
                : media.remap === true))
    );
}
