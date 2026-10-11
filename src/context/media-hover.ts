import * as vscode from 'vscode';
import { InspectionService } from './inspection-service';
import { parsePropertyLine, valueAtCharacter, soundValueAtCharacter } from './ini-position';
import { ThumbnailStore } from './thumbnail-store';
import { DecoderService } from '../media/decoder-service';
import { localize } from '../i18n';
import { Inspection, MediaPayload } from './workbench-protocol';
import { ByteCache } from '../media/byte-cache';
interface HoverPreview {
    inspection: Pick<Inspection, 'focus' | 'type' | 'assets'>;
    kind?: MediaPayload['kind'];
    image?: string;
}

export class MediaHoverProvider implements vscode.HoverProvider, vscode.Disposable {
    private readonly thumbnails: ThumbnailStore;
    private cache = new ByteCache<HoverPreview>(16 * 1024 * 1024);
    private pending = new Map<string, Promise<HoverPreview | undefined>>();
    private cancellations = new Set<vscode.CancellationTokenSource>();
    private disposables: vscode.Disposable[] = [];
    private generation = 0;
    constructor(
        private readonly service: InspectionService,
        context: vscode.ExtensionContext,
        decoder: DecoderService
    ) {
        this.thumbnails = new ThumbnailStore(context, decoder);
        const invalidate = () => {
            this.generation++;
            this.cache.clear();
        };
        this.disposables.push(
            service.resources.onDidChange(invalidate),
            service.onDidChangePreview(invalidate),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId === 'ra2-ini') {
                    invalidate();
                }
            })
        );
        context.subscriptions?.push(this);
    }
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position.line).text;
        const property = parsePropertyLine(line);
        const element =
            property &&
            (this.service.ini.category(document.uri) === 'sound' && property.key.toLowerCase() === 'sounds'
                ? soundValueAtCharacter(line, property, position.character)
                : valueAtCharacter(property, position.character));
        if (property && !element) {
            return undefined;
        }
        if (!property && !/^\s*\[/.test(line)) {
            return undefined;
        }
        if (!vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('media.enabled', true)) {
            return undefined;
        }
        if (!vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('media.hoverEnabled', true)) {
            return undefined;
        }
        try {
            const generation = this.generation;
            const key =
                generation +
                ':' +
                document.uri.toString() +
                ':' +
                document.version +
                ':' +
                position.line +
                ':' +
                (element?.value ?? '');
            let preview = this.cache.get(key);
            if (!preview) {
                let pending = this.pending.get(key);
                if (!pending && this.pending.size < 2) {
                    const cancellation = new vscode.CancellationTokenSource();
                    this.cancellations.add(cancellation);
                    pending = this.service
                        .inspect(document, position, cancellation.token)
                        .then(async (session) => {
                            if (!session) {
                                return undefined;
                            }
                            const thumbnail = await this.thumbnails.create(
                                session.inspection.media ?? session.inspection.cameo,
                                cancellation.token
                            );
                            const image = thumbnail
                                ? 'data:image/png;base64,' +
                                  Buffer.from(await vscode.workspace.fs.readFile(thumbnail)).toString('base64')
                                : undefined;
                            const inspection = session.inspection;
                            const result = {
                                inspection: {
                                    focus: inspection.focus,
                                    type: inspection.type,
                                    assets: inspection.assets,
                                },
                                kind: inspection.media?.kind,
                                image,
                            };
                            if (generation === this.generation && !cancellation.token.isCancellationRequested) {
                                this.cache.set(
                                    key,
                                    result,
                                    (image?.length ?? 0) + JSON.stringify(inspection.assets).length
                                );
                            }
                            return result;
                        })
                        .catch((error) => {
                            console.debug('[MediaHover] Preview unavailable', error);
                            return undefined;
                        })
                        .finally(() => {
                            this.pending.delete(key);
                            this.cancellations.delete(cancellation);
                            cancellation.dispose();
                        });
                    this.pending.set(key, pending);
                }
                if (pending) {
                    preview = await new Promise((resolve) => {
                        const timer = setTimeout(() => resolve(undefined), 180);
                        void pending!.then((value) => {
                            clearTimeout(timer);
                            resolve(value);
                        });
                    });
                }
            }
            if (token.isCancellationRequested) {
                return undefined;
            }
            const section = this.service.ini.parse(document).getSectionAt(position.line);
            if (!section) {
                return undefined;
            }
            const inspection = preview?.inspection ?? {
                focus: element?.value ?? section.name,
                type: this.service.ini.type(document.uri, section.name, this.service.ini.category(document.uri)),
                media: undefined,
                assets: [],
            };
            if (preview && !preview.kind && !inspection.assets.length) {
                return undefined;
            }
            const markdown = new vscode.MarkdownString('', true);
            markdown.isTrusted = { enabledCommands: ['ra2-ini-intellisense.inspect'] };
            markdown.appendText(inspection.focus + ' · ' + inspection.type);
            if (preview?.image) {
                markdown.appendMarkdown('\n\n![](' + preview.image + ')');
            } else if (!preview) {
                markdown.appendText(
                    '\n\n' + localize('workbench.preparingPreview', 'Preparing preview in the background…')
                );
            }
            if (preview?.kind === 'audio') {
                markdown.appendText(
                    '\n\n' + localize('workbench.sampleCount', '{0} available samples', inspection.assets.length)
                );
            }
            if (inspection.assets[0]) {
                markdown.appendText('\n\n' + inspection.assets[0].source);
            }
            const args = encodeURIComponent(
                JSON.stringify([document.uri.toString(), position.line, position.character])
            );
            markdown.appendMarkdown(
                '\n\n[' +
                    (preview?.kind === 'audio'
                        ? localize('workbench.openAudio', 'Open player')
                        : preview?.kind === 'voxel'
                          ? localize('workbench.openModel', 'View model')
                          : localize('workbench.openPreview', 'View asset')) +
                    '](command:ra2-ini-intellisense.inspect?' +
                    args +
                    ')'
            );
            return new vscode.Hover(
                markdown,
                element
                    ? new vscode.Range(position.line, element.start, position.line, element.end)
                    : document.lineAt(position.line).range
            );
        } catch (error) {
            if (!token.isCancellationRequested) {
                console.debug('[MediaHover] Preview unavailable', error);
            }
            return undefined;
        }
    }

    public dispose(): void {
        this.generation++;
        this.cancellations.forEach((cancellation) => {
            cancellation.cancel();
            cancellation.dispose();
        });
        this.cancellations.clear();
        this.disposables.forEach((item) => item.dispose());
        this.disposables = [];
        this.cache.clear();
        this.pending.clear();
    }
}
