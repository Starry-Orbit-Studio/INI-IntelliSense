import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { MediaPayload } from './workbench-protocol';
import { DecoderService } from '../media/decoder-service';

export class ThumbnailStore {
    private cache = new Map<string, vscode.Uri>();
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly decoder: DecoderService
    ) {}

    public async create(
        media: MediaPayload | undefined,
        token: vscode.CancellationToken,
        animate = false
    ): Promise<vscode.Uri | undefined> {
        if (!media || !['sprite', 'image', 'voxel'].includes(media.kind)) {
            return undefined;
        }
        const hash = createHash('sha256')
            .update(animate ? 'animated-v3' : 'static-v3')
            .update(
                media.kind === 'sprite'
                    ? media.bytes +
                          media.palette.join(',') +
                          String(media.shadow) +
                          String(media.remap === true) +
                          JSON.stringify(media.actions.map((entry) => [entry.action, entry.valid])) +
                          JSON.stringify(
                              media.scene?.layers.map((layer) => ({
                                  tag: layer.tag,
                                  state: layer.state,
                                  damaged: layer.damaged,
                                  offset: layer.offset,
                                  z: layer.z,
                                  start: layer.start,
                                  end: layer.end,
                                  rate: layer.rate,
                                  remap: layer.remap,
                                  media: layer.media,
                                  voxel: layer.voxel ? { ...layer.voxel, points: [] } : undefined,
                              }))
                          )
                    : media.kind === 'image'
                      ? media.width + 'x' + media.height + ':' + media.pixels
                      : JSON.stringify({ ...media, points: [] })
            )
            .digest('hex');
        const cached = this.cache.get(hash);
        if (cached) {
            return cached;
        }
        const png =
            media.kind === 'sprite'
                ? await this.decoder.decode<Uint8Array>(
                      animate ? 'animated-thumbnail' : media.scene ? 'scene-thumbnail' : 'thumbnail',
                      Buffer.from(media.bytes, 'base64'),
                      token,
                      undefined,
                      {
                          palette: media.palette,
                          frame: 0,
                          shadow: media.shadow,
                          remap: media.remap === true,
                          sprite: media,
                          animate,
                      }
                  )
                : media.kind === 'image'
                  ? await this.decoder.decode<Uint8Array>(
                        'rgba-thumbnail',
                        Buffer.from(media.pixels, 'base64'),
                        token,
                        undefined,
                        { palette: [], frame: 0, image: { width: media.width, height: media.height } }
                    )
                  : media.kind === 'voxel'
                    ? await this.decoder.decode<Uint8Array>(
                          animate ? 'animated-thumbnail' : 'voxel-thumbnail',
                          new Uint8Array(),
                          token,
                          undefined,
                          {
                              palette: media.palette,
                              frame: 0,
                              voxel: { ...media, points: [] },
                          }
                      )
                    : undefined;
        if (!png) {
            return undefined;
        }
        if (token.isCancellationRequested) {
            return undefined;
        }
        const root = vscode.Uri.joinPath(this.context.globalStorageUri, 'thumbnails');
        await vscode.workspace.fs.createDirectory(root);
        const uri = vscode.Uri.joinPath(root, hash + '.png');
        await vscode.workspace.fs.writeFile(uri, png);
        this.cache.set(hash, uri);
        if (this.cache.size > 128) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        const entries = await vscode.workspace.fs.readDirectory(root);
        if (entries.length > 256) {
            const keep = new Set([...this.cache.values()].map((item) => item.path.split('/').pop()));
            for (const [name] of entries) {
                if (/^[a-f0-9]{64}\.png$/.test(name) && !keep.has(name)) {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, name));
                }
            }
        }
        return uri;
    }
}
