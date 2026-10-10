/** Small hand-authored files exercise format boundaries without game assets. */
export function shpFixture(format = 3): Uint8Array {
    const data = format === 3 ? [5, 0, 1, 0, 1, 4, 0, 2, 3] : format === 2 ? [4, 0, 1, 2, 3, 4] : [1, 2, 3, 4];
    const bytes = new Uint8Array(32 + data.length),
        view = new DataView(bytes.buffer);
    view.setUint16(2, 2, true);
    view.setUint16(4, 2, true);
    view.setUint16(6, 1, true);
    view.setUint16(12, 2, true);
    view.setUint16(14, 2, true);
    bytes[16] = format;
    view.setUint32(28, 32, true);
    bytes.set(data, 32);
    return bytes;
}

export function voxelFixture(): Uint8Array {
    const body = 830,
        footer = 843,
        bytes = new Uint8Array(footer + 92),
        view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('Voxel Animation'), 0);
    view.setUint32(20, 1, true);
    view.setUint32(24, 1, true);
    view.setUint32(28, 13, true);
    bytes[32] = 16;
    bytes[33] = 31;
    bytes.set(Buffer.from('MAIN'), 802);
    view.setUint32(body, 0, true);
    view.setUint32(body + 4, 4, true);
    bytes.set([0, 1, 10, 1, 1], body + 8);
    view.setUint32(footer + 4, 4, true);
    view.setUint32(footer + 8, 8, true);
    view.setFloat32(footer + 12, 1 / 12, true);
    [0, 5, 10].forEach((i) => view.setFloat32(footer + 16 + i * 4, 1, true));
    [1, 1, 1].forEach((value, i) => view.setFloat32(footer + 76 + i * 4, value, true));
    bytes.set([1, 1, 1, 4], footer + 88);
    return bytes;
}

export function hvaFixture(): Uint8Array {
    const bytes = new Uint8Array(88),
        view = new DataView(bytes.buffer);
    view.setUint32(16, 1, true);
    view.setUint32(20, 1, true);
    bytes.set(Buffer.from('main'), 24);
    [0, 5, 10].forEach((i) => view.setFloat32(40 + i * 4, 1, true));
    view.setFloat32(52, 12, true);
    return bytes;
}

export function idxFixture(flags = 6, length = 4): Uint8Array {
    const bytes = new Uint8Array(48),
        view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('GABA'));
    view.setUint32(4, 2, true);
    view.setUint32(8, 1, true);
    bytes.set(Buffer.from('sample'), 12);
    view.setUint32(32, length, true);
    view.setUint32(36, 22050, true);
    view.setUint32(40, flags, true);
    view.setUint32(44, flags & 8 ? length : 0, true);
    return bytes;
}
