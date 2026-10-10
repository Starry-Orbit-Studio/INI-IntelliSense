import { parentPort } from 'worker_threads';
import { readShp, decodeShpFrame } from './shp';
import { encodePng } from './png';
import { readVoxel, readHva } from './voxel';
import { decodeWav, decodeBagSample, encodeWav, BagSample } from './audio';
import { createPcxPreview } from '../preview/pcx-preview';
import { voxelThumbnail } from './voxel-thumbnail';
import type { DecodeOptions } from './decoder-service';

parentPort?.on(
    'message',
    (message: { id: number; kind: string; bytes: Uint8Array; sample?: BagSample; options?: DecodeOptions }) => {
        try {
            const bytes = new Uint8Array(message.bytes);
            let result: unknown;
            switch (message.kind) {
                case 'voxel-thumbnail': {
                    if (!message.options?.voxel) {
                        throw new Error('Missing voxel thumbnail model.');
                    }
                    result = voxelThumbnail(message.options.voxel);
                    break;
                }
                case 'shp':
                    result = readShp(bytes);
                    break;
                case 'voxel':
                    result = readVoxel(bytes);
                    break;
                case 'hva':
                    result = readHva(bytes);
                    break;
                case 'pcx':
                    result = createPcxPreview(bytes, '');
                    break;
                case 'rgba-thumbnail':
                case 'pcx-thumbnail': {
                    const image =
                        message.kind === 'pcx-thumbnail'
                            ? createPcxPreview(bytes, '')
                            : {
                                  width: message.options?.image?.width ?? 0,
                                  height: message.options?.image?.height ?? 0,
                                  pixels: bytes,
                              };
                    if (
                        !image.width ||
                        !image.height ||
                        image.width * image.height > 4 * 1024 * 1024 ||
                        image.pixels.length !== image.width * image.height * 4
                    ) {
                        throw new Error('Invalid thumbnail pixels.');
                    }
                    const ratio = Math.min(1, 96 / Math.max(image.width, image.height));
                    const width = Math.max(1, Math.round(image.width * ratio)),
                        height = Math.max(1, Math.round(image.height * ratio));
                    const rgba = new Uint8Array(width * height * 4);
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const source =
                                (Math.min(image.height - 1, Math.floor(y / ratio)) * image.width +
                                    Math.min(image.width - 1, Math.floor(x / ratio))) *
                                4;
                            rgba.set(image.pixels.subarray(source, source + 4), (y * width + x) * 4);
                        }
                    }
                    result = encodePng(width, height, rgba);
                    break;
                }
                case 'thumbnail': {
                    const file = readShp(bytes),
                        indexed = decodeShpFrame(bytes, file, message.options?.frame ?? 0);
                    const palette = message.options?.palette ?? [];
                    const ratio = Math.min(1, 96 / Math.max(file.width, file.height));
                    const width = Math.max(1, Math.round(file.width * ratio)),
                        height = Math.max(1, Math.round(file.height * ratio));
                    const rgba = new Uint8Array(width * height * 4);
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const color =
                                indexed[
                                    Math.min(file.height - 1, Math.floor(y / ratio)) * file.width +
                                        Math.min(file.width - 1, Math.floor(x / ratio))
                                ];
                            const at = (y * width + x) * 4;
                            if (color) {
                                rgba[at] = palette[color * 3];
                                rgba[at + 1] = palette[color * 3 + 1];
                                rgba[at + 2] = palette[color * 3 + 2];
                                rgba[at + 3] = 255;
                            }
                        }
                    }
                    result = encodePng(width, height, rgba);
                    break;
                }
                case 'audio': {
                    const audio = message.sample ? decodeBagSample(bytes, message.sample) : decodeWav(bytes);
                    result = {
                        wav: encodeWav(audio),
                        duration: audio.samples.length / audio.channels / audio.rate,
                        rate: audio.rate,
                        channels: audio.channels,
                    };
                    break;
                }
                default:
                    throw new Error('Unsupported decoder task.');
            }
            parentPort?.postMessage({ id: message.id, result });
        } catch (error) {
            parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
);
