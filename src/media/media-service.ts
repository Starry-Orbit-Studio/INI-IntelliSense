import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectResources, ResourceCandidate } from '../resources/project-resources';
import { DecoderService } from './decoder-service';
import { readPalette } from '../preview/palette-utils';
import { GAME_NORMALS } from './voxel-normals';
import { VoxelFile, HvaFile, attachHva } from './voxel';
import { ShpFile } from './shp';
import { BagSample, readBagIndex } from './audio';
import { MediaPayload, ActionEdit, PointEdit } from '../context/workbench-protocol';
import { localize } from '../i18n';

export interface MediaOptions {
    origin?: vscode.Uri;
    palette?: vscode.Uri;
    paletteName?: string;
    animation?: boolean;
    shadow?: boolean;
    actions?: ActionEdit[];
    points?: PointEdit[];
    light?: number[];
    fixed?: boolean;
    voxel?: boolean;
    turret?: boolean;
    turretOffset?: number[];
    volume?: number;
    loop?: boolean;
    sample?: BagSample;
}

/** Host-side resource acquisition; CPU-heavy parsing stays in the decoder worker. */
export class MediaService {
    constructor(
        public readonly resources: ProjectResources,
        private readonly decoder: DecoderService,
        private readonly extension: vscode.Uri
    ) {}

    public async thumbnail(
        candidate: ResourceCandidate,
        token?: vscode.CancellationToken,
        origin = candidate.uri
    ): Promise<Uint8Array | undefined> {
        const extension = path.posix.extname(candidate.name).toLowerCase();
        if (['.vxl', '.hva'].includes(extension)) {
            const media = await this.load(candidate, { origin }, token);
            if (media.kind !== 'voxel') {
                return undefined;
            }
            return this.decoder.decode<Uint8Array>('voxel-thumbnail', new Uint8Array(), token, undefined, {
                palette: media.palette,
                frame: 0,
                voxel: media,
            });
        }
        if (!['.shp', '.pcx'].includes(extension)) {
            return undefined;
        }
        const bytes = await this.resources.read(candidate.uri);
        return this.decoder.decode<Uint8Array>(
            extension === '.shp' ? 'thumbnail' : 'pcx-thumbnail',
            bytes,
            token,
            undefined,
            { palette: await this.palette(origin), frame: 0 }
        );
    }

    public async palette(origin: vscode.Uri, options: MediaOptions = {}): Promise<number[]> {
        const preferred = options.palette
            ? options.palette
            : (
                  await this.resources.find(
                      origin,
                      options.paletteName ?? (options.animation ? 'anim.pal' : 'unittem.pal')
                  )
              )[0]?.uri;
        const uri = preferred ?? vscode.Uri.joinPath(this.extension, 'assets', 'palettes', 'unittem.pal');
        const colors = readPalette(await this.resources.read(uri, 1024 * 1024));
        return colors.flatMap((color) => [color.r, color.g, color.b]);
    }

    public async load(
        candidate: ResourceCandidate,
        options: MediaOptions = {},
        token?: vscode.CancellationToken
    ): Promise<MediaPayload> {
        const origin = options.origin ?? candidate.uri;
        const bytes = options.sample
            ? await this.resources.readRange(candidate.uri, options.sample.offset, options.sample.length)
            : await this.resources.read(candidate.uri);
        const extension = path.posix.extname(candidate.name).toLowerCase();
        const name = candidate.name;
        if (options.sample || extension === '.wav') {
            const data = bytes;
            const audio = await this.decoder.decode<{
                wav: Uint8Array;
                duration: number;
                rate: number;
                channels: number;
            }>('audio', data, token, options.sample);
            return {
                kind: 'audio',
                name,
                bytes: Buffer.from(audio.wav).toString('base64'),
                duration: audio.duration,
                rate: audio.rate,
                channels: audio.channels,
                volume: options.volume ?? 1,
                loop: options.loop ?? false,
            };
        }
        if (['.mp3', '.ogg', '.flac'].includes(extension)) {
            // Browser-supported containers use an explicit MIME in the UI.
            return {
                kind: 'audio',
                name,
                bytes: Buffer.from(bytes).toString('base64'),
                duration: 0,
                rate: 0,
                channels: 0,
                volume: options.volume ?? 1,
                loop: options.loop ?? false,
            };
        }
        if (extension === '.shp') {
            const file = await this.decoder.decode<ShpFile>('shp', bytes, token);
            return {
                kind: 'sprite',
                name,
                bytes: Buffer.from(bytes).toString('base64'),
                file,
                palette: await this.palette(origin, options),
                actions: options.actions ?? [],
                shadow: options.shadow ?? false,
            };
        }
        if (extension === '.pcx') {
            const image = await this.decoder.decode<{ width: number; height: number; pixels: Uint8ClampedArray }>(
                'pcx',
                bytes,
                token
            );
            return {
                kind: 'image',
                name,
                width: image.width,
                height: image.height,
                pixels: Buffer.from(image.pixels).toString('base64'),
            };
        }
        if (extension === '.pal') {
            return { kind: 'palette', name, colors: await this.palette(candidate.uri, { palette: candidate.uri }) };
        }
        if (extension === '.vxl' || extension === '.hva') {
            const base = path.posix.basename(name, extension);
            const main = extension === '.hva' ? (await this.resources.find(origin, base + '.vxl'))[0] : candidate;
            if (!main) {
                throw new Error('A matching VXL was not found.');
            }
            const model = await this.decoder.decode<VoxelFile>('voxel', await this.resources.read(main.uri), token);
            const parts: { base: string; model: VoxelFile; role: 'body' | 'turret' | 'barrel' }[] = [
                { base, model, role: 'body' },
            ];
            if (options.turret !== false) {
                for (const [suffix, role] of [
                    ['tur', 'turret'],
                    ['barl', 'barrel'],
                ] as const) {
                    const resource = await this.companion(main, base + suffix + '.vxl', origin);
                    if (resource) {
                        const child = await this.decoder.decode<VoxelFile>(
                            'voxel',
                            await this.resources.read(resource.uri),
                            token
                        );
                        parts.push({ base: base + suffix, model: child, role });
                    }
                }
            }
            for (const item of parts) {
                const hva =
                    extension === '.hva' && item.role === 'body'
                        ? candidate
                        : await this.companion(main, item.base + '.hva', origin);
                if (hva) {
                    attachHva(
                        item.model,
                        await this.decoder.decode<HvaFile>('hva', await this.resources.read(hva.uri), token)
                    );
                }
                for (const part of item.model.parts) {
                    part.role = item.role;
                    if (item.role !== 'body' && options.turretOffset) {
                        const offset = options.turretOffset;
                        part.offset = [0, 1, 2].map((axis) => offset[axis] ?? 0);
                    }
                }
            }
            model.parts = parts.flatMap((item) => item.model.parts);
            if (model.parts.reduce((count, part) => count + part.voxels.length / 5, 0) > 500000) {
                throw new Error('Assembled model exceeds the voxel budget.');
            }
            if (model.parts.some((part) => part.normalsMode !== 4)) {
                throw new Error(
                    localize(
                        'workbench.normalsUnsupported',
                        'This VXL uses a normal table other than the supported RA2 table (mode 4).'
                    )
                );
            }
            const vplCandidate = (await this.resources.find(origin, 'voxels.vpl'))[0];
            const vplBytes = await this.resources.read(
                vplCandidate?.uri ?? vscode.Uri.joinPath(this.extension, 'assets', 'palettes', 'voxels.vpl')
            );
            const vplView = new DataView(vplBytes.buffer, vplBytes.byteOffset, vplBytes.byteLength);
            const sections = vplBytes.length >= 784 ? vplView.getUint32(8, true) : 0;
            if (!sections || sections > 256 || sections * 256 > vplBytes.length - 784) {
                throw new Error('Invalid VPL lookup.');
            }
            return {
                kind: 'voxel',
                name,
                model,
                palette: await this.palette(origin, options),
                vpl: [...vplBytes.subarray(784, 784 + sections * 256)],
                normals: GAME_NORMALS.flatMap((normal) => [normal.x, normal.y, normal.z]),
                light: options.light ?? [0.201, -0.907, -0.362],
                fixed: options.fixed ?? false,
                points: options.points ?? [],
            };
        }
        throw new Error('Unsupported media format: ' + extension);
    }

    private async companion(
        main: ResourceCandidate,
        name: string,
        origin: vscode.Uri
    ): Promise<ResourceCandidate | undefined> {
        const candidates = await this.resources.find(origin, name);
        return (
            candidates.find(
                (item) =>
                    item.uri.query === main.uri.query &&
                    path.posix.dirname(item.uri.path) === path.posix.dirname(main.uri.path)
            ) ?? candidates[0]
        );
    }

    public async samples(
        origin: vscode.Uri,
        name: string
    ): Promise<{ candidate: ResourceCandidate; sample?: BagSample }[]> {
        const base = name.replace(/^[\$#]+/, '').replace(/\.wav$/i, '');
        const loose = await this.resources.find(origin, base + '.wav');
        const found: { candidate: ResourceCandidate; sample?: BagSample }[] = loose.map((candidate) => ({ candidate }));
        const indexes = new Map<string, ResourceCandidate>();
        for (const index of [
            ...(await this.resources.list(origin, ['.idx'])),
            ...(await this.resources.find(origin, 'audio.idx')),
            ...(await this.resources.find(origin, 'audiomd.idx')),
        ]) {
            indexes.set(index.uri.toString(), index);
        }
        for (const index of indexes.values()) {
            try {
                const sample = readBagIndex(await this.resources.read(index.uri, 8 * 1024 * 1024)).find(
                    (item) => item.name.toLowerCase() === base.toLowerCase()
                );
                if (!sample) {
                    continue;
                }
                const bagName = index.name.replace(/\.idx$/i, '.bag');
                const candidates = await this.resources.find(origin, bagName);
                const sibling = candidates.find(
                    (item) =>
                        path.posix.dirname(item.uri.path) === path.posix.dirname(index.uri.path) &&
                        item.uri.query === index.uri.query
                );
                const bag = sibling ?? candidates[0];
                if (bag) {
                    found.push({ candidate: { ...bag, name: base + '.wav', source: index.source }, sample });
                }
            } catch {
                /* Missing/corrupt banks remain unavailable without blocking other samples. */
            }
        }
        return found;
    }
}
