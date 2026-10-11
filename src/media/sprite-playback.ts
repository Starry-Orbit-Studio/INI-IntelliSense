import type { SequenceAction } from './shp';

/** Sequence time is relative to a clip; source frames remain absolute. */
export function spriteClip(frameCount: number, shadow: boolean, action?: SequenceAction, direction = 0) {
    const bodyFrames = Math.max(1, shadow ? Math.floor(frameCount / 2) : frameCount);
    const start = action ? action.start + Math.max(0, Math.min(7, direction)) * action.stride : 0;
    const count = Math.max(1, Math.min(action?.count ?? bodyFrames, bodyFrames - start));
    return {
        start,
        count,
        frame: (time: number) => Math.max(0, Math.min(bodyFrames - 1, start + (((time % count) + count) % count))),
    };
}
