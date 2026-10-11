import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { createHash } from 'crypto';
import { BagSample } from './audio';
import { ByteCache } from './byte-cache';
import type { VoxelFile } from './voxel';
import type { MediaPayload } from '../context/workbench-protocol';

export interface DecodeOptions {
    palette: number[];
    frame: number;
    voxel?: Extract<MediaPayload, { kind: 'voxel' }>;
    sprite?: Extract<MediaPayload, { kind: 'sprite' }>;
    shadow?: boolean;
    image?: { width: number; height: number };
}

interface Job {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

/** Isolate binary decoding, bound pending work and recover after timeouts/crashes. */
export class DecoderService implements vscode.Disposable {
    private worker?: Worker;
    private pending = new Map<number, Job>();
    private sequence = 0;
    private disposed = false;
    private readonly cache = new ByteCache<unknown>(64 * 1024 * 1024);

    constructor(private readonly workerPath: string) {}

    public async decode<T>(
        kind: string,
        bytes: Uint8Array,
        token?: vscode.CancellationToken,
        sample?: BagSample,
        options?: DecodeOptions
    ): Promise<T> {
        if (this.disposed || token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const key = createHash('sha256')
            .update(kind)
            .update(bytes)
            .update(JSON.stringify([sample, options]))
            .digest('hex');
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return structuredClone(cached) as T;
        }
        if (this.pending.size >= 16) {
            throw new Error('Decoder queue is full.');
        }
        if (!this.worker) {
            this.start();
        }
        const id = ++this.sequence;
        return new Promise<T>((resolve, reject) => {
            const cancellation = token?.onCancellationRequested(() => {
                const job = this.pending.get(id);
                if (job) {
                    job.reject(new vscode.CancellationError());
                }
            });
            const timer = setTimeout(() => this.reset(new Error('Resource decoding timed out.')), 15000);
            this.pending.set(id, {
                resolve: (value) => {
                    cancellation?.dispose();
                    const size = this.decodedSize(kind, value, bytes.length);
                    if (size <= 64 * 1024 * 1024) {
                        this.cache.set(key, structuredClone(value), size);
                    }
                    resolve(value as T);
                },
                reject: (error) => {
                    cancellation?.dispose();
                    reject(error);
                },
                timer,
            });
            // Copy rather than transfer: resource cache retains ownership of its buffers.
            this.worker!.postMessage({ id, kind, bytes, sample, options });
        });
    }

    private decodedSize(kind: string, value: unknown, source: number): number {
        if (value instanceof Uint8Array) {
            return value.byteLength;
        }
        if (kind === 'voxel') {
            return (value as VoxelFile).parts.reduce((total, part) => total + part.voxels.length * 8 + 2048, 0);
        }
        const result = value as { pixels?: Uint8ClampedArray; wav?: Uint8Array; frames?: unknown[] };
        return (
            result.pixels?.byteLength ??
            result.wav?.byteLength ??
            (kind === 'shp' ? (result.frames?.length ?? 0) * 96 : source * 4)
        );
    }

    private start(): void {
        const worker = new Worker(this.workerPath);
        this.worker = worker;
        worker.on('message', (message: { id: number; result: unknown; error?: string }) => {
            const job = this.pending.get(message.id);
            if (!job) {
                return;
            }
            clearTimeout(job.timer);
            this.pending.delete(message.id);
            if (message.error) {
                job.reject(new Error(message.error));
            } else {
                job.resolve(message.result);
            }
        });
        worker.on('error', (error) => {
            if (this.worker === worker) {
                this.reset(error);
            }
        });
        worker.on('exit', (code) => {
            if (this.worker === worker) {
                this.reset(new Error('Decoder exited: ' + code));
            }
        });
    }

    private reset(error: Error): void {
        const worker = this.worker;
        this.worker = undefined;
        for (const job of this.pending.values()) {
            clearTimeout(job.timer);
            job.reject(error);
        }
        this.pending.clear();
        void worker?.terminate();
    }
    public dispose(): void {
        this.disposed = true;
        this.cache.clear();
        this.reset(new Error('Decoder disposed.'));
    }
}
