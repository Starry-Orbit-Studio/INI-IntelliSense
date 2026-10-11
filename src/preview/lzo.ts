/** Decode a bounded LZO1X stream. Invalid offsets, truncated streams and size mismatches fail closed. */
export function decompressLzo(block: Uint8Array, size: number): Uint8Array {
    if (!Number.isInteger(size) || size < 0 || size > 65535) {
        throw new Error('Invalid LZO output size.');
    }
    const output = new Uint8Array(size);
    let input = 0,
        written = 0;
    const byte = () => {
        if (input >= block.length) {
            throw new Error('Truncated LZO stream.');
        }
        return block[input++];
    };
    const literals = (length: number) => {
        if (input + length > block.length || written + length > size) {
            throw new Error('LZO literal exceeds buffer.');
        }
        output.set(block.subarray(input, input + length), written);
        input += length;
        written += length;
    };
    const match = (distance: number, length: number) => {
        if (distance < 1 || distance > written || written + length > size) {
            throw new Error('Invalid LZO back-reference.');
        }
        for (let i = 0; i < length; i++) {
            output[written] = output[written - distance];
            written++;
        }
    };
    const extended = (base: number) => {
        let value = 0,
            next = byte();
        while (next === 0) {
            value += 255;
            next = byte();
        }
        return value + base + next;
    };
    let token = byte();
    // State is the number of literals following the previous match, or 4 after a literal run.
    let state = 0;
    if (token > 17) {
        const length = token - 17;
        literals(length);
        state = Math.min(length, 4);
        token = byte();
    }
    for (;;) {
        let trailing: number;
        if (token < 16 && state === 0) {
            literals((token || extended(15)) + 3);
            state = 4;
            token = byte();
            continue;
        }
        if (token >= 64) {
            match(1 + ((token >> 2) & 7) + (byte() << 3), (token >> 5) + 1);
            trailing = token & 3;
        } else if (token >= 32) {
            const length = token & 31 || extended(31);
            const low = byte(),
                high = byte();
            match(1 + (low >> 2) + (high << 6), length + 2);
            trailing = low & 3;
        } else if (token >= 16) {
            const length = token & 7 || extended(7);
            const low = byte(),
                high = byte();
            const offset = ((token & 8) << 11) + (low >> 2) + (high << 6);
            if (offset === 0) {
                if (token !== 17 || input !== block.length || written !== size) {
                    throw new Error('Invalid LZO end marker or output size.');
                }
                return output;
            }
            match(0x4000 + offset, length + 2);
            trailing = low & 3;
        } else {
            match((state === 4 ? 0x801 : 1) + (token >> 2) + (byte() << 2), state === 4 ? 3 : 2);
            trailing = token & 3;
        }
        literals(trailing);
        state = trailing;
        token = byte();
    }
}
