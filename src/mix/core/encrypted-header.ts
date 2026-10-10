import { BinaryReader } from '../../media/binary-reader';

// Westwood's published DER integer identifies the archive key modulus.
const PUBLIC_MODULUS = Buffer.from('AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V', 'base64').subarray(2);
function integer(bytes: Uint8Array, littleEndian: boolean): bigint {
    let value = 0n;
    for (let i = 0; i < bytes.length; i++) {
        value = (value << 8n) | BigInt(bytes[littleEndian ? bytes.length - i - 1 : i]);
    }
    return value;
}
function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    base %= modulus;
    while (exponent) {
        if (exponent & 1n) {
            result = (result * base) % modulus;
        }
        base = (base * base) % modulus;
        exponent >>= 1n;
    }
    return result;
}
/** Two 40-byte little-endian RSA blocks produce 39 bytes each; Blowfish uses the first 56. */
export function mixKey(source: Uint8Array): Uint8Array {
    if (source.length !== 80) {
        throw new Error('Invalid encrypted MIX key block.');
    }
    const modulus = integer(PUBLIC_MODULUS, false),
        output = new Uint8Array(78);
    for (let block = 0; block < 2; block++) {
        let value = power(integer(source.subarray(block * 40, block * 40 + 40), true), 65537n, modulus);
        for (let i = 0; i < 39; i++) {
            output[block * 39 + i] = Number(value & 255n);
            value >>= 8n;
        }
    }
    return output.subarray(0, 56);
}
/** Convert 32-bit word storage between byte orders. */
export function swapWords(bytes: Uint8Array): Uint8Array {
    if (bytes.length % 4) {
        throw new Error('Invalid encrypted MIX block alignment.');
    }
    const output = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 4) {
        output.set([bytes[i + 3], bytes[i + 2], bytes[i + 1], bytes[i]], i);
    }
    return output;
}
export async function decryptMixHeader(
    bytes: Uint8Array,
    readHeader?: (offset: number, length: number) => Promise<Uint8Array>
): Promise<{ bytes: Uint8Array; bodyOffset: number }> {
    const reader = new BinaryReader(bytes);
    reader.require(0, 92);
    const { Blowfish } = await import('egoroof-blowfish');
    const cipher = new Blowfish(mixKey(bytes.subarray(4, 84)), Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
    const decode = (data: Uint8Array) => {
        const restored = new Uint8Array(data.length);
        // The encrypted block uses standard Blowfish byte order; only its plaintext fields are little-endian.
        restored.set(cipher.decode(data, Blowfish.TYPE.UINT8_ARRAY));
        return restored;
    };
    const first = new BinaryReader(decode(bytes.subarray(84, 92))),
        count = first.u16(0);
    if (!count) {
        throw new Error('Invalid encrypted MIX file count.');
    }
    const length = Math.ceil((6 + count * 12) / 8) * 8;
    if (readHeader) {
        const encrypted = await readHeader(84, length);
        new BinaryReader(encrypted).require(0, length);
        return { bytes: decode(encrypted), bodyOffset: 84 + length };
    }
    reader.require(84, length);
    return { bytes: decode(bytes.subarray(84, 84 + length)), bodyOffset: 84 + length };
}
