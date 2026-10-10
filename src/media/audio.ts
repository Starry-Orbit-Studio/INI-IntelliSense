import { BinaryReader } from './binary-reader';

export interface BagSample {
    name: string;
    offset: number;
    length: number;
    rate: number;
    flags: number;
    block: number;
}
export interface PcmAudio {
    samples: Int16Array;
    channels: number;
    rate: number;
}
const MAX_SAMPLES = 16 * 1024 * 1024;
const STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
function clamp(value: number): number {
    return Math.max(-32768, Math.min(32767, value));
}

export function readBagIndex(bytes: Uint8Array): BagSample[] {
    const reader = new BinaryReader(bytes);
    if (reader.ascii(0, 4) !== 'GABA' || reader.u32(4) !== 2) {
        throw new Error('Unsupported IDX signature.');
    }
    const count = reader.u32(8);
    if (count > 100000) {
        throw new Error('IDX exceeds the sample budget.');
    }
    reader.require(12, count * 36);
    return Array.from({ length: count }, (_, index) => {
        const at = 12 + index * 36;
        return {
            name: reader.ascii(at, 16),
            offset: reader.u32(at + 16),
            length: reader.u32(at + 20),
            rate: reader.u32(at + 24),
            flags: reader.u32(at + 28),
            block: reader.u32(at + 32),
        };
    });
}

function validateFormat(channels: number, rate: number): void {
    if ((channels !== 1 && channels !== 2) || rate < 4000 || rate > 192000) {
        throw new Error('Unsupported audio channel count or sample rate.');
    }
}

export function decodeIma(bytes: Uint8Array, channels: number, block: number): Int16Array {
    if (!Number.isInteger(block) || block < channels * 4 || block > 65536) {
        throw new Error('Invalid IMA block size.');
    }
    const capacity = Math.floor(bytes.length / block + 1) * ((block - channels * 4) * 2 + channels);
    if (capacity > MAX_SAMPLES) {
        throw new Error('Audio exceeds the decoded sample budget.');
    }
    const result = new Int16Array(capacity);
    let written = 0;
    for (let offset = 0; offset < bytes.length; offset += block) {
        const size = Math.min(block, bytes.length - offset);
        if (size < channels * 4) {
            throw new Error('Truncated IMA block header.');
        }
        const reader = new BinaryReader(bytes.subarray(offset, offset + size));
        const predictors = Array.from({ length: channels }, (_, channel) => reader.i16(channel * 4));
        const indexes = Array.from({ length: channels }, (_, channel) => reader.bytes[channel * 4 + 2]);
        if (indexes.some((index) => index > 88)) {
            throw new Error('Invalid IMA step index.');
        }
        for (const predictor of predictors) {
            result[written++] = predictor;
        }
        let cursor = channels * 4;
        while (cursor < size) {
            const remaining = size - cursor;
            const chunk = Math.min(4, Math.floor(remaining / channels));
            if (!chunk) {
                throw new Error('Truncated stereo IMA group.');
            }
            const group: number[][] = [];
            for (let channel = 0; channel < channels; channel++) {
                const output: number[] = [];
                for (let i = 0; i < chunk; i++) {
                    const byte = reader.bytes[cursor++];
                    for (const nibble of [byte & 15, byte >>> 4]) {
                        const step = STEPS[indexes[channel]];
                        const delta =
                            (step >> 3) +
                            (nibble & 1 ? step >> 2 : 0) +
                            (nibble & 2 ? step >> 1 : 0) +
                            (nibble & 4 ? step : 0);
                        predictors[channel] = clamp(predictors[channel] + (nibble & 8 ? -delta : delta));
                        indexes[channel] = Math.max(0, Math.min(88, indexes[channel] + INDEX[nibble & 7]));
                        output.push(predictors[channel]);
                    }
                }
                group.push(output);
            }
            for (let i = 0; i < chunk * 2; i++) {
                for (let channel = 0; channel < channels; channel++) {
                    result[written++] = group[channel][i];
                }
            }
        }
    }
    return result.slice(0, written);
}

function decodeMs(bytes: Uint8Array, channels: number, block: number, coefficients: number[][]): Int16Array {
    const adaptation = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
    if (block < channels * 7 || block > 65536 || bytes.length * 2 > MAX_SAMPLES) {
        throw new Error('Invalid MS ADPCM block size.');
    }
    const output: number[] = [];
    for (let at = 0; at < bytes.length; at += block) {
        const part = bytes.subarray(at, Math.min(at + block, bytes.length)),
            reader = new BinaryReader(part);
        reader.require(0, channels * 7);
        const predictor = [...part.subarray(0, channels)];
        if (predictor.some((value) => !coefficients[value])) {
            throw new Error('Invalid MS ADPCM predictor.');
        }
        const delta = Array.from({ length: channels }, (_, i) => reader.u16(channels + i * 2));
        const recent = Array.from({ length: channels }, (_, i) => reader.i16(channels * 3 + i * 2));
        const previous = Array.from({ length: channels }, (_, i) => reader.i16(channels * 5 + i * 2));
        output.push(...previous, ...recent);
        for (let i = channels * 7; i < part.length; i++) {
            for (let half = 0; half < 2; half++) {
                const channel = channels === 2 ? half : 0;
                const nibble = half === 0 ? part[i] >>> 4 : part[i] & 15;
                const coefficient = coefficients[predictor[channel]];
                const value = clamp(
                    Math.floor((recent[channel] * coefficient[0] + previous[channel] * coefficient[1]) / 256) +
                        (nibble < 8 ? nibble : nibble - 16) * delta[channel]
                );
                previous[channel] = recent[channel];
                recent[channel] = value;
                delta[channel] = Math.max(16, Math.floor((delta[channel] * adaptation[nibble]) / 256));
                output.push(value);
            }
        }
        if (output.length > MAX_SAMPLES) {
            throw new Error('Audio exceeds the decoded sample budget.');
        }
    }
    return Int16Array.from(output);
}

function decodePcm(bytes: Uint8Array, bits: number): Int16Array {
    if (![8, 16].includes(bits) || bytes.length % (bits / 8) || (bytes.length * 8) / bits > MAX_SAMPLES) {
        throw new Error('Unsupported or invalid PCM audio.');
    }
    const reader = new BinaryReader(bytes);
    return Int16Array.from({ length: (bytes.length * 8) / bits }, (_, i) =>
        bits === 8 ? (bytes[i] - 128) * 256 : reader.i16(i * 2)
    );
}

export function decodeBagSample(bytes: Uint8Array, sample: BagSample): PcmAudio {
    const channels = sample.flags & 1 ? 2 : 1;
    validateFormat(channels, sample.rate);
    if (sample.flags & ~15 || !(sample.flags & 10) || (sample.flags & 10) === 10) {
        throw new Error('Unsupported BAG audio flags.');
    }
    const samples = sample.flags & 8 ? decodeIma(bytes, channels, sample.block) : decodePcm(bytes, 16);
    if (samples.length % channels) {
        throw new Error('Incomplete audio frame.');
    }
    return { samples, channels, rate: sample.rate };
}

export function decodeWav(bytes: Uint8Array): PcmAudio {
    const reader = new BinaryReader(bytes);
    if (reader.ascii(0, 4) !== 'RIFF' || reader.ascii(8, 4) !== 'WAVE') {
        throw new Error('Unsupported audio container.');
    }
    const end = reader.u32(4) + 8;
    if (end < 12 || end > bytes.length) {
        throw new Error('Truncated WAV container.');
    }
    let format = 0,
        channels = 0,
        rate = 0,
        bits = 0,
        block = 0,
        fact = 0;
    let data: Uint8Array | undefined;
    let coefficients = [
        [256, 0],
        [512, -256],
        [0, 0],
        [192, 64],
        [240, 0],
        [460, -208],
        [392, -232],
    ];
    for (let cursor = 12; cursor + 8 <= end;) {
        const name = reader.ascii(cursor, 4),
            length = reader.u32(cursor + 4);
        cursor += 8;
        if (cursor + length > end) {
            throw new Error('WAV chunk exceeds its container.');
        }
        reader.require(cursor, length);
        if (name === 'fmt ') {
            if (length < 16) {
                throw new Error('Invalid WAV format chunk.');
            }
            format = reader.u16(cursor);
            channels = reader.u16(cursor + 2);
            rate = reader.u32(cursor + 4);
            block = reader.u16(cursor + 12);
            bits = reader.u16(cursor + 14);
            if (format === 2 && length >= 22) {
                const count = reader.u16(cursor + 20);
                if (!count || count > 256 || length < 22 + count * 4) {
                    throw new Error('Invalid ADPCM coefficients.');
                }
                coefficients = Array.from({ length: count }, (_, i) => [
                    reader.i16(cursor + 22 + i * 4),
                    reader.i16(cursor + 24 + i * 4),
                ]);
            }
        } else if (name === 'data') {
            data = bytes.subarray(cursor, cursor + length);
        } else if (name === 'fact' && length >= 4) {
            fact = reader.u32(cursor);
        }
        cursor += length + (length & 1);
    }
    validateFormat(channels, rate);
    if (!data) {
        throw new Error('Missing WAV audio data.');
    }
    let samples =
        format === 1
            ? decodePcm(data, bits)
            : format === 17
              ? decodeIma(data, channels, block)
              : format === 2
                ? decodeMs(data, channels, block, coefficients)
                : undefined;
    if (!samples) {
        throw new Error('Unsupported WAV encoding: ' + format);
    }
    if (fact && fact * channels < samples.length) {
        samples = samples.slice(0, fact * channels);
    }
    if (samples.length % channels) {
        throw new Error('Incomplete WAV audio frame.');
    }
    return { samples, channels, rate };
}

export function encodeWav(audio: PcmAudio): Uint8Array {
    validateFormat(audio.channels, audio.rate);
    const output = new Uint8Array(44 + audio.samples.length * 2),
        view = new DataView(output.buffer);
    const ascii = (at: number, value: string) =>
        [...value].forEach((char, i) => {
            output[at + i] = char.charCodeAt(0);
        });
    ascii(0, 'RIFF');
    view.setUint32(4, output.length - 8, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, audio.channels, true);
    view.setUint32(24, audio.rate, true);
    view.setUint32(28, audio.rate * audio.channels * 2, true);
    view.setUint16(32, audio.channels * 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, audio.samples.length * 2, true);
    audio.samples.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
    return output;
}
