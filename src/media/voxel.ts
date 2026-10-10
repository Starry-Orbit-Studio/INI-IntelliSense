import { BinaryReader } from './binary-reader';

export const MAX_VOXELS = 1_000_000;

export interface VoxelPart {
    name: string;
    size: number[];
    bounds: number[];
    scale: number;
    matrix: number[];
    normalsMode: number;
    voxels: number[];
    role: 'body' | 'turret' | 'barrel';
    animation?: number[][];
    offset?: number[];
}
export interface VoxelFile {
    remapStart: number;
    remapEnd: number;
    parts: VoxelPart[];
}

/** Preserve native model coordinates; camera conversion belongs to the renderer. */
export function readVoxel(bytes: Uint8Array): VoxelFile {
    const reader = new BinaryReader(bytes);
    reader.require(0, 802);
    if (!reader.ascii(0, 16).startsWith('Voxel Animation')) {
        throw new Error('Invalid VXL signature.');
    }
    const count = reader.u32(20),
        bodyLength = reader.u32(28);
    if (count < 1 || count > 128) {
        throw new Error('Invalid VXL limb count.');
    }
    const body = 802 + count * 28,
        footer = body + bodyLength;
    reader.require(802, count * 28);
    reader.require(body, bodyLength);
    reader.require(footer, count * 92);
    const parts: VoxelPart[] = [];
    let total = 0;
    for (let limb = 0; limb < count; limb++) {
        const at = footer + limb * 92;
        const size = [...bytes.subarray(at + 88, at + 91)];
        if (size.some((value) => !value)) {
            throw new Error('Invalid VXL limb dimensions.');
        }
        const bounds = Array.from({ length: 6 }, (_, i) => reader.f32(at + 64 + i * 4));
        if (bounds.slice(0, 3).some((value, i) => value > bounds[i + 3])) {
            throw new Error('Invalid VXL bounds.');
        }
        const part: VoxelPart = {
            name: reader.ascii(802 + limb * 28, 16),
            size,
            bounds,
            scale: reader.f32(at + 12),
            matrix: Array.from({ length: 12 }, (_, i) => reader.f32(at + 16 + i * 4)),
            normalsMode: bytes[at + 91],
            voxels: [],
            role: 'body',
        };
        const startTable = body + reader.u32(at),
            endTable = body + reader.u32(at + 4),
            data = body + reader.u32(at + 8);
        const columns = size[0] * size[1];
        reader.require(startTable, columns * 4);
        reader.require(endTable, columns * 4);
        if (data < body || data > footer || startTable + columns * 4 > footer || endTable + columns * 4 > footer) {
            throw new Error('VXL span table exceeds the body.');
        }
        for (let column = 0; column < columns; column++) {
            const start = reader.u32(startTable + column * 4),
                end = reader.u32(endTable + column * 4);
            if (start === 0xffffffff) {
                continue;
            }
            let cursor = data + start,
                z = 0;
            const limit = data + end + 1;
            if (end < start || limit > footer) {
                throw new Error('Invalid VXL column offsets.');
            }
            while (cursor < limit && z < size[2]) {
                reader.require(cursor, 2);
                z += bytes[cursor++];
                const run = bytes[cursor++];
                if (z + run > size[2] || cursor + run * 2 + 1 > limit) {
                    throw new Error('Invalid VXL run.');
                }
                for (let i = 0; i < run; i++, z++) {
                    const color = bytes[cursor++],
                        normal = bytes[cursor++];
                    if (color) {
                        if (++total > MAX_VOXELS) {
                            throw new Error('VXL exceeds the voxel budget.');
                        }
                        part.voxels.push(column % size[0], Math.floor(column / size[0]), z, color, normal);
                    }
                }
                if (bytes[cursor++] !== run) {
                    throw new Error('Invalid VXL repeated run count.');
                }
            }
        }
        parts.push(part);
    }
    return { remapStart: bytes[32], remapEnd: bytes[33], parts };
}

export interface HvaFile {
    names: string[];
    frames: number[][][];
}
export function readHva(bytes: Uint8Array): HvaFile {
    const reader = new BinaryReader(bytes);
    reader.require(0, 24);
    const count = reader.u32(16),
        limbs = reader.u32(20);
    if (!count || count > 4096 || !limbs || limbs > 128 || count * limbs > 65536) {
        throw new Error('Invalid HVA dimensions.');
    }
    const offset = 24 + limbs * 16;
    reader.require(24, limbs * 16);
    reader.require(offset, count * limbs * 48);
    const names = Array.from({ length: limbs }, (_, i) => reader.ascii(24 + i * 16, 16));
    const frames = Array.from({ length: count }, (_, frame) =>
        Array.from({ length: limbs }, (_, limb) =>
            Array.from({ length: 12 }, (_, i) => reader.f32(offset + (frame * limbs + limb) * 48 + i * 4))
        )
    );
    return { names, frames };
}

export function attachHva(model: VoxelFile, hva: HvaFile): void {
    for (const part of model.parts) {
        const index = hva.names.findIndex((name) => name.toLowerCase() === part.name.toLowerCase());
        if (index >= 0) {
            part.animation = hva.frames.map((frame) => frame[index]);
        }
    }
}
