/** Checked binary reads and bounded allocations for untrusted game resources. */
export class BinaryReader {
    public readonly view: DataView;
    constructor(public readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    public require(offset: number, length: number): void {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            offset > this.bytes.length - length
        ) {
            throw new Error('Truncated or invalid resource offset.');
        }
    }
    public u16(offset: number): number {
        this.require(offset, 2);
        return this.view.getUint16(offset, true);
    }
    public i16(offset: number): number {
        this.require(offset, 2);
        return this.view.getInt16(offset, true);
    }
    public u32(offset: number): number {
        this.require(offset, 4);
        return this.view.getUint32(offset, true);
    }
    public f32(offset: number): number {
        this.require(offset, 4);
        const value = this.view.getFloat32(offset, true);
        if (!Number.isFinite(value)) {
            throw new Error('Invalid floating point value.');
        }
        return value;
    }
    public ascii(offset: number, length: number): string {
        this.require(offset, length);
        const slice = this.bytes.subarray(offset, offset + length);
        const zero = slice.indexOf(0);
        return String.fromCharCode(...slice.subarray(0, zero < 0 ? length : zero));
    }
}

export function checkedPixels(width: number, height: number, limit = 4 * 1024 * 1024): number {
    const count = width * height;
    if (
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        count > limit
    ) {
        throw new Error('Resource dimensions exceed the preview budget.');
    }
    return count;
}
