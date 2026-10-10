import { BinaryReader, checkedPixels } from './binary-reader';

export interface ShpFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    format: number;
    offset: number;
}
export interface ShpFile {
    width: number;
    height: number;
    frames: ShpFrame[];
}

/** TS/RA2 SHP, including empty frames and formats 0, 1, 2 and 3. */
export function readShp(bytes: Uint8Array): ShpFile {
    const reader = new BinaryReader(bytes);
    reader.require(0, 8);
    if (reader.u16(0) !== 0) {
        throw new Error('Unsupported SHP signature.');
    }
    const width = reader.u16(2),
        height = reader.u16(4),
        count = reader.u16(6);
    checkedPixels(width, height);
    if (!count || count > 16384) {
        throw new Error('Invalid SHP frame count.');
    }
    reader.require(8, count * 24);
    const frames: ShpFrame[] = [];
    for (let index = 0; index < count; index++) {
        const at = 8 + index * 24;
        const frame = {
            x: reader.u16(at),
            y: reader.u16(at + 2),
            width: reader.u16(at + 4),
            height: reader.u16(at + 6),
            format: bytes[at + 8],
            offset: reader.u32(at + 20),
        };
        if (
            frame.format > 3 ||
            frame.x + frame.width > width ||
            frame.y + frame.height > height ||
            (frame.offset !== 0 && frame.offset < 8 + count * 24) ||
            (frame.width > 0 && frame.height > 0 && frame.offset >= bytes.length)
        ) {
            throw new Error('Unsupported SHP frame or bounds.');
        }
        if (frame.width && frame.height) {
            checkedPixels(frame.width, frame.height);
        }
        frames.push(frame);
    }
    return { width, height, frames };
}

export function decodeShpFrame(bytes: Uint8Array, file: ShpFile, index: number): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= file.frames.length) {
        throw new Error('Invalid SHP frame index.');
    }
    const frame = file.frames[index];
    const output = new Uint8Array(file.width * file.height);
    if (!frame.offset || !frame.width || !frame.height) {
        return output;
    }
    const reader = new BinaryReader(bytes);
    let cursor = frame.offset;
    let fixedLength = frame.width;
    if (frame.format === 2) {
        fixedLength = reader.u16(cursor) - 2;
        cursor += 2;
        if (fixedLength < 0 || fixedLength > frame.width) {
            throw new Error('Invalid SHP scanline width.');
        }
    }
    for (let y = 0; y < frame.height; y++) {
        const row = new Uint8Array(frame.width);
        if (frame.format === 3) {
            const length = reader.u16(cursor);
            cursor += 2;
            if (length < 2) {
                throw new Error('Invalid SHP scanline length.');
            }
            reader.require(cursor, length - 2);
            const end = cursor + length - 2;
            let x = 0;
            while (cursor < end) {
                const value = bytes[cursor++];
                if (value === 0) {
                    if (cursor >= end) {
                        throw new Error('Truncated SHP transparent run.');
                    }
                    x += bytes[cursor++];
                } else {
                    if (x >= frame.width) {
                        throw new Error('SHP scanline overflows its bounds.');
                    }
                    row[x++] = value;
                }
                if (x > frame.width) {
                    throw new Error('SHP transparent run overflows its bounds.');
                }
            }
        } else {
            reader.require(cursor, fixedLength);
            row.set(bytes.subarray(cursor, cursor + fixedLength));
            cursor += fixedLength;
        }
        const targetY = frame.y + y;
        if (targetY >= file.height) {
            continue;
        }
        const length = Math.min(frame.width, file.width - frame.x);
        if (length > 0) {
            output.set(row.subarray(0, length), targetY * file.width + frame.x);
        }
    }
    return output;
}

export interface SequenceAction {
    name: string;
    start: number;
    count: number;
    stride: number;
    extra: string[];
    raw: string;
}

export function parseSequenceAction(name: string, value: string): SequenceAction | undefined {
    const parts = value.split(',').map((part) => part.trim());
    if (parts.length < 3 || !parts.slice(0, 3).every((part) => /^\d+$/.test(part))) {
        return undefined;
    }
    const [start, count, stride] = parts.map(Number);
    if (count < 1 || count > 16384 || start > 65535 || stride > 65535) {
        return undefined;
    }
    return { name, start, count, stride, extra: parts.slice(3), raw: value };
}

export function sequenceFrame(action: SequenceAction, direction: number, frame: number): number {
    return action.start + direction * action.stride + frame;
}

export function validateSequence(action: SequenceAction, frames: number, directions: number): boolean {
    return action.start >= 0 && sequenceFrame(action, Math.max(0, directions - 1), action.count - 1) < frames;
}
