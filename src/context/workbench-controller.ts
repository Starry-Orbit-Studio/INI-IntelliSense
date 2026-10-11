import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { InspectionService, InspectionSession } from './inspection-service';
import { ProjectResources, ResourceCandidate } from '../resources/project-resources';
import { MediaService } from '../media/media-service';
import { HostState } from './workbench-protocol';
import { workbenchHtml } from './workbench-html';
import { workbenchLabels } from './workbench-labels';
import { applyVisualEdit } from './visual-edit';
import { localize } from '../i18n';
import { encodePng } from '../media/png';
import { mediaCapabilities } from '../media/media-capabilities';

class WorkbenchSession implements vscode.Disposable {
    public pinned = false;
    public current?: InspectionSession;
    private cancellation = new vscode.CancellationTokenSource();
    private revision = 0;
    private ready = false;
    private loading = false;
    private error?: string;
    private thumbnails = 0;
    private history: { uri: vscode.Uri; position: vscode.Position; resource?: boolean }[] = [];
    private target?: { uri: vscode.Uri; position: vscode.Position; resource?: boolean };
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly extension: vscode.Uri,
        private readonly service: InspectionService,
        private readonly media: MediaService,
        private readonly visible: () => boolean
    ) {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extension, 'dist', 'workbench')],
        };
        this.disposables.push(
            webview.onDidReceiveMessage((message) => {
                void this.message(message).catch((error) => {
                    this.error = error instanceof Error ? error.message : String(error);
                    this.send();
                });
            })
        );
        webview.html = workbenchHtml(webview, extension);
    }

    public async follow(editor: vscode.TextEditor): Promise<void> {
        if (this.pinned || !this.visible() || editor.document.languageId !== 'ra2-ini') {
            return;
        }
        if (
            !vscode.workspace.getConfiguration('ra2-ini-intellisense', editor.document.uri).get('media.enabled', true)
        ) {
            return;
        }
        await this.inspect(editor.document.uri, editor.selection.active);
    }

    public async inspect(uri: vscode.Uri, position: vscode.Position, resource = false, record = true): Promise<void> {
        if (
            record &&
            this.target &&
            (this.target.uri.toString() !== uri.toString() || this.target.position.line !== position.line)
        ) {
            this.history.push({ ...this.target });
            this.history = this.history.slice(-12);
        }
        this.target = { uri, position, resource };
        const revision = ++this.revision;
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.cancellation = new vscode.CancellationTokenSource();
        const token = this.cancellation.token;
        this.loading = true;
        this.error = undefined;
        this.send();
        try {
            let current: InspectionSession | undefined;
            if (resource) {
                const candidate: ResourceCandidate = {
                    uri,
                    name: path.posix.basename(uri.path),
                    source: uri.toString(),
                    priority: 0,
                };
                const id = randomUUID();
                current = {
                    origin: uri,
                    position,
                    selected: id,
                    options: {},
                    inspection: {
                        id: randomUUID(),
                        owner: candidate.name,
                        type: path.posix.extname(uri.path).slice(1).toUpperCase(),
                        focus: candidate.name,
                        sources: [],
                        references: [],
                        properties: [],
                        assets: [
                            {
                                name: candidate.name,
                                priority: candidate.priority,
                                id,
                                source: this.service.resources.label(uri, uri),
                                role: candidate.role,
                            },
                        ],
                        paletteOptions: [],
                        warnings: [],
                    },
                    assets: new Map([[id, { candidate, options: { origin: uri } }]]),
                    links: new Map(),
                    edits: new Map(),
                };
                const contextual = await this.service.inspectResource(candidate, token);
                if (contextual) {
                    current = contextual;
                    current.assets.set(id, { candidate, options: contextual.options });
                    current.inspection.assets.unshift({
                        id,
                        name: candidate.name,
                        source: this.service.resources.label(uri, candidate.uri),
                        priority: 0,
                    });
                    current.inspection.focus = candidate.name;
                } else {
                    current.assets.get(id)!.options = await this.service.projectMediaOptions(uri);
                }
                await this.service.select(current, id, token);
                current.inspection.paletteOptions = (
                    current.inspection.media && mediaCapabilities(current.inspection.media.kind).palette
                        ? await this.service.resources.list(uri, ['.pal'])
                        : []
                ).map((candidate) => {
                    const paletteId = randomUUID();
                    current!.assets.set(paletteId, { candidate, options: { origin: uri } });
                    return {
                        id: paletteId,
                        name: candidate.name,
                        source: this.service.resources.label(uri, candidate.uri),
                        priority: candidate.priority,
                    };
                });
            } else {
                const document = await vscode.workspace.openTextDocument(uri);
                current = await this.service.inspect(document, position, token);
            }
            if (revision !== this.revision || token.isCancellationRequested) {
                return;
            }
            if (current) {
                this.current = current;
            }
        } catch (error) {
            if (revision !== this.revision || token.isCancellationRequested) {
                return;
            }
            this.current = undefined;
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            if (revision === this.revision) {
                this.loading = false;
                this.send();
            }
        }
    }

    public refresh(): void {
        if (this.target && this.visible()) {
            void this.inspect(this.target.uri, this.target.position, this.target.resource, false);
        }
    }

    public async browse(origin: vscode.Uri): Promise<void> {
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.cancellation = new vscode.CancellationTokenSource();
        const revision = ++this.revision,
            token = this.cancellation.token;
        this.loading = true;
        this.send();
        try {
            const candidates = await this.service.resources.list(origin, [
                '.shp',
                '.vxl',
                '.hva',
                '.pcx',
                '.wav',
                '.pal',
                '.mp3',
                '.ogg',
                '.flac',
            ]);
            const current: InspectionSession = {
                origin,
                position: new vscode.Position(0, 0),
                assets: new Map(),
                links: new Map(),
                edits: new Map(),
                options: {},
                inspection: {
                    id: randomUUID(),
                    owner: localize('workbench.library', 'Asset library'),
                    type: '',
                    focus: '',
                    properties: [],
                    sources: [],
                    references: [],
                    assets: [],
                    paletteOptions: [],
                    warnings: [],
                    library: [],
                },
            };
            for (const candidate of candidates.slice(0, 10000)) {
                const id = randomUUID();
                current.assets.set(id, { candidate, options: { origin } });
                current.inspection.library!.push({
                    id,
                    name: candidate.name,
                    source: this.service.resources.label(origin, candidate.uri),
                    priority: candidate.priority,
                });
            }
            if (token.isCancellationRequested || revision !== this.revision) {
                return;
            }
            this.current = current;
            this.target = undefined;
            this.pinned = true;
        } finally {
            if (revision === this.revision) {
                this.loading = false;
                this.send();
            }
        }
    }

    private send(): void {
        if (!this.ready) {
            return;
        }
        const state: HostState = {
            type: 'state',
            labels: workbenchLabels(),
            inspection: this.current?.inspection,
            loading: this.loading,
            pinned: this.pinned,
            error: this.error,
        };
        void this.webview.postMessage(state);
    }

    private async message(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const data = message as {
            type?: string;
            id?: string;
            inspection?: string;
            values?: unknown;
            palette?: string;
            layer?: string;
            theater?: string;
            pixels?: string;
            width?: number;
            height?: number;
        };
        if (data.type === 'ready') {
            this.ready = true;
            this.send();
            return;
        }
        if (data.type === 'pin') {
            this.pinned = !this.pinned;
            this.send();
            return;
        }
        if (data.type === 'refresh') {
            this.service.resources.invalidate();
            this.refresh();
            return;
        }
        if (data.type === 'back') {
            const previous = this.history.pop();
            if (previous) {
                await this.inspect(previous.uri, previous.position, previous.resource, false);
            }
            return;
        }
        if (!this.current || data.inspection !== this.current.inspection.id) {
            return;
        }
        const current = this.current;
        if (
            data.type === 'theater' &&
            data.theater &&
            ['tem', 'sno', 'urb', 'ubn', 'lun', 'des'].includes(data.theater)
        ) {
            this.service.setPreviewTheater(current.origin, data.theater);
        } else if (data.type === 'source' && data.id) {
            const location = current.links.get(data.id);
            if (location) {
                await vscode.window.showTextDocument(location.uri, { selection: location.range, preserveFocus: false });
            }
        } else if (data.type === 'thumbnail' && data.id) {
            const asset = current.assets.get(data.id);
            if (!asset || this.thumbnails >= 4) {
                return;
            }
            this.thumbnails++;
            try {
                const bytes = await this.media.thumbnail(asset.candidate, this.cancellation.token, current.origin, {
                    ...(await this.service.projectMediaOptions(current.origin)),
                    ...asset.options,
                });
                if (this.current === current) {
                    void this.webview.postMessage({
                        type: 'thumbnail',
                        inspection: current.inspection.id,
                        id: data.id,
                        bytes: bytes ? Buffer.from(bytes).toString('base64') : undefined,
                    });
                }
            } catch {
                void this.webview.postMessage({ type: 'thumbnail', inspection: current.inspection.id, id: data.id });
            } finally {
                this.thumbnails--;
            }
        } else if (data.type === 'select' && data.id) {
            const revision = ++this.revision;
            this.cancellation.cancel();
            this.cancellation.dispose();
            this.cancellation = new vscode.CancellationTokenSource();
            this.loading = true;
            this.send();
            try {
                await this.service.select(current, data.id, this.cancellation.token, data.palette, data.layer);
            } finally {
                if (revision === this.revision) {
                    this.loading = false;
                    this.send();
                }
            }
        } else if (data.type === 'edit' && data.id) {
            const target = current.edits.get(data.id);
            if (target) {
                await applyVisualEdit(target, data.values);
                this.refresh();
            }
        } else if (data.type === 'browse') {
            await this.browse(current.origin);
        } else if (data.type === 'replace') {
            await this.replace(current);
        } else if (data.type === 'export') {
            const media = current.inspection.media;
            if (!media) {
                return;
            }
            let bytes: Uint8Array;
            let extension: string;
            if (media.kind === 'audio') {
                bytes = Buffer.from(media.bytes, 'base64');
                extension = path.posix.extname(media.name) || '.wav';
            } else {
                if (
                    !data.width ||
                    !data.height ||
                    typeof data.pixels !== 'string' ||
                    data.pixels.length > 24 * 1024 * 1024
                ) {
                    return;
                }
                bytes = encodePng(data.width, data.height, Buffer.from(data.pixels, 'base64'));
                extension = '.png';
            }
            const root = this.service.resources.projectRoot(current.origin);
            const destination = await vscode.window.showSaveDialog({
                defaultUri: ['file', 'vscode-remote'].includes(root.scheme)
                    ? vscode.Uri.joinPath(
                          root,
                          path.posix.basename(media.name, path.posix.extname(media.name)) + extension
                      )
                    : undefined,
            });
            if (destination) {
                await vscode.workspace.fs.writeFile(destination, bytes);
            }
        }
    }

    private async replace(session: InspectionSession): Promise<void> {
        const target = session.replacement;
        if (!target) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(target.uri);
        const choices: { label: string; description: string; replacement: string }[] = [];
        if (target.category) {
            const seen = new Set<string>();
            for (const doc of this.service.ini.documents(target.uri)) {
                if (this.service.ini.category(doc.uri) !== target.category) {
                    continue;
                }
                for (const section of doc.sections) {
                    if (seen.has(section.name.toLowerCase())) {
                        continue;
                    }
                    seen.add(section.name.toLowerCase());
                    if (
                        target.category === 'rules' &&
                        target.type &&
                        this.service.ini.type(doc.uri, section.name, 'rules') !== target.type
                    ) {
                        continue;
                    }
                    choices.push({ label: section.name, description: doc.uri.toString(), replacement: section.name });
                }
            }
        } else if (target.extension) {
            for (const candidate of await this.service.resources.list(target.uri, [target.extension])) {
                choices.push({
                    label: candidate.name,
                    description: this.service.resources.label(session.origin, candidate.uri),
                    replacement: path.posix.extname(target.original)
                        ? candidate.name
                        : path.posix.basename(candidate.name, path.posix.extname(candidate.name)),
                });
            }
        }
        const chosen = await vscode.window.showQuickPick(choices, {
            placeHolder: localize(
                'workbench.replacePlaceholder',
                'Choose a replacement for the current Image / file reference'
            ),
        });
        if (!chosen) {
            return;
        }
        if (document.version !== target.version || document.getText(target.range) !== target.original) {
            throw new Error(
                localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
            );
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, target.range, chosen.replacement);
        await vscode.workspace.applyEdit(edit);
        this.refresh();
    }

    public dispose(): void {
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.disposables.forEach((item) => item.dispose());
        this.current = undefined;
        this.history = [];
    }
}

/** One lifecycle owner for cursor following, standalone editors and commands. */
export class WorkbenchController
    implements vscode.WebviewViewProvider, vscode.CustomReadonlyEditorProvider, vscode.Disposable
{
    public static readonly viewId = 'ra2-object-inspector';
    private view?: vscode.WebviewView;
    private inspector?: WorkbenchSession;
    private sessions = new Set<WorkbenchSession>();
    private timer?: NodeJS.Timeout;
    private disposables: vscode.Disposable[] = [];
    private autoRevealed = false;
    private cursorRevision = 0;
    private autoCancellation?: vscode.CancellationTokenSource;
    private backgroundRoots = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        public readonly service: InspectionService,
        private readonly media: MediaService
    ) {
        const schedule = () => {
            this.cursorRevision++;
            this.autoCancellation?.cancel();
            this.autoCancellation?.dispose();
            this.autoCancellation = undefined;
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.timer = setTimeout(() => {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document.languageId === 'ra2-ini') {
                    const root = service.resources.projectRoot(editor.document.uri).toString();
                    if (!this.backgroundRoots.has(root)) {
                        this.backgroundRoots.add(root);
                        void Promise.all([
                            service.ini.load(editor.document.uri),
                            media.warm(editor.document.uri),
                        ]).catch((error) => console.debug('[Workbench] Background indexing failed', error));
                    }
                    void this.inspector?.follow(editor);
                    if (
                        !this.autoRevealed &&
                        vscode.workspace
                            .getConfiguration('ra2-ini-intellisense', editor.document.uri)
                            .get('media.autoReveal', true) &&
                        vscode.workspace
                            .getConfiguration('ra2-ini-intellisense', editor.document.uri)
                            .get('media.enabled', true)
                    ) {
                        const revision = this.cursorRevision;
                        const cancellation = new vscode.CancellationTokenSource();
                        this.autoCancellation = cancellation;
                        void service
                            .inspect(editor.document, editor.selection.active, cancellation.token)
                            .then(async (session) => {
                                if (
                                    revision !== this.cursorRevision ||
                                    this.autoRevealed ||
                                    !session ||
                                    (!session.inspection.assets.length && !session.inspection.media)
                                ) {
                                    return;
                                }
                                this.autoRevealed = true;
                                if (this.view) {
                                    this.view.show(true);
                                } else {
                                    await vscode.commands.executeCommand(WorkbenchController.viewId + '.focus', {
                                        preserveFocus: true,
                                    });
                                }
                            })
                            .catch((error) => console.debug('[Workbench] Auto reveal unavailable', error))
                            .finally(() => cancellation.dispose());
                    }
                }
            }, 140);
        };
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(schedule),
            vscode.window.onDidChangeActiveTextEditor(schedule),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId === 'ra2-ini') {
                    schedule();
                    this.sessions.forEach((session) => {
                        if (session.pinned) {
                            session.refresh();
                        }
                    });
                }
            }),
            service.onDidChangePreview((origin) => {
                const root = service.resources.projectRoot(origin).toString();
                for (const session of this.sessions) {
                    if (session.current && service.resources.projectRoot(session.current.origin).toString() === root) {
                        session.refresh();
                    }
                }
            }),
            service.resources.onDidChange((uri) => {
                if (!uri || /\.(ini|map|mpr|yrm|mix|dll)$/i.test(uri.path)) {
                    this.backgroundRoots.clear();
                    service.ini.invalidate();
                }
                this.sessions.forEach((session) => session.refresh());
                schedule();
            }),
            vscode.commands.registerCommand(
                'ra2-ini-intellisense.inspect',
                async (uri?: string, line?: number, character?: number) => {
                    const editor = vscode.window.activeTextEditor;
                    const target = typeof uri === 'string' ? vscode.Uri.parse(uri) : editor?.document.uri;
                    if (!target || !['file', 'ra2mix', 'untitled', 'vscode-remote'].includes(target.scheme)) {
                        return;
                    }
                    if (
                        (line !== undefined && (!Number.isInteger(line) || line < 0)) ||
                        (character !== undefined && (!Number.isInteger(character) || character < 0))
                    ) {
                        return;
                    }
                    await vscode.commands.executeCommand(WorkbenchController.viewId + '.focus');
                    await this.inspector?.inspect(
                        target,
                        new vscode.Position(
                            Math.max(0, line ?? editor?.selection.active.line ?? 0),
                            Math.max(0, character ?? editor?.selection.active.character ?? 0)
                        )
                    );
                }
            ),
            vscode.commands.registerCommand('ra2-ini-intellisense.browseAssets', async () => {
                const origin =
                    vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!origin) {
                    return;
                }
                const panel = vscode.window.createWebviewPanel(
                    'ra2-asset-library',
                    localize('workbench.library', 'Asset library'),
                    vscode.ViewColumn.Active,
                    { retainContextWhenHidden: true }
                );
                const session = new WorkbenchSession(
                    panel.webview,
                    context.extensionUri,
                    service,
                    media,
                    () => panel.visible
                );
                this.sessions.add(session);
                panel.onDidDispose(() => {
                    session.dispose();
                    this.sessions.delete(session);
                });
                const visibility = panel.onDidChangeViewState(() => {
                    void panel.webview.postMessage({ type: 'visibility', visible: panel.visible });
                });
                panel.onDidDispose(() => visibility.dispose());
                await session.browse(origin);
            })
        );
        schedule();
    }

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const session = new WorkbenchSession(
            view.webview,
            this.context.extensionUri,
            this.service,
            this.media,
            () => view.visible
        );
        this.inspector = session;
        this.sessions.add(session);
        this.disposables.push(
            view.onDidChangeVisibility(() => {
                void view.webview.postMessage({ type: 'visibility', visible: view.visible });
                if (view.visible && vscode.window.activeTextEditor) {
                    void session.follow(vscode.window.activeTextEditor);
                }
            }),
            view.onDidDispose(() => {
                session.dispose();
                this.sessions.delete(session);
                if (this.inspector === session) {
                    this.inspector = undefined;
                }
            })
        );
        if (vscode.window.activeTextEditor) {
            void session.follow(vscode.window.activeTextEditor);
        }
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => undefined };
    }
    public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
        const session = new WorkbenchSession(
            panel.webview,
            this.context.extensionUri,
            this.service,
            this.media,
            () => panel.visible
        );
        this.sessions.add(session);
        panel.title = path.posix.basename(document.uri.path);
        const visibility = panel.onDidChangeViewState(() => {
            void panel.webview.postMessage({ type: 'visibility', visible: panel.visible });
        });
        panel.onDidDispose(() => {
            visibility.dispose();
            session.dispose();
            this.sessions.delete(session);
        });
        await session.inspect(document.uri, new vscode.Position(0, 0), true);
    }
    public dispose(): void {
        this.autoCancellation?.cancel();
        this.autoCancellation?.dispose();
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.sessions.forEach((session) => session.dispose());
        this.sessions.clear();
        this.disposables.forEach((item) => item.dispose());
    }
}
