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
import { openContributedView } from './view-reveal';
import { applyPropertyChanges, preparePropertyChanges, PropertyChange } from './property-edit';
import { CATALOG_GROUPS, catalogGroup } from './catalog-groups';
import { renderMap, MapRendererOptions } from './map-renderer';
import { ConfigurationService } from './configuration-service';
import { ConfigurationScope } from './configuration-model';
import { configurationMessage } from './configuration-channel';
import { commandOrigin } from './command-origin';

class WorkbenchSession implements vscode.Disposable {
    public pinned = false;
    public current?: InspectionSession;
    private cancellation = new vscode.CancellationTokenSource();
    private revision = 0;
    private ready = false;
    private loading = false;
    private editing = false;
    private catalogOrigin?: vscode.Uri;
    private catalogScope = 'game';
    private changePlan?: { id: string; changes: PropertyChange[] };
    private planRevision = 0;
    private error?: string;
    private thumbnails = 0;
    private history: { uri: vscode.Uri; position: vscode.Position; resource?: boolean }[] = [];
    private readonly configuration: ConfigurationService;
    private configurationScope?: ConfigurationScope;
    private target?: { uri: vscode.Uri; position: vscode.Position; resource?: boolean };
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly extension: vscode.Uri,
        private readonly service: InspectionService,
        private readonly media: MediaService,
        private readonly visible: () => boolean,
        private readonly preferences?: vscode.Memento
    ) {
        this.configuration = new ConfigurationService(extension);
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extension, 'dist', 'workbench')],
        };
        this.disposables.push(
            webview.onDidReceiveMessage((message) => {
                void this.message(message).catch((error) => {
                    if (error instanceof vscode.CancellationError) {
                        return;
                    }
                    this.error = error instanceof Error ? error.message : String(error);
                    this.send();
                });
            })
        );
        webview.html = workbenchHtml(webview, extension);
    }

    public async follow(editor: vscode.TextEditor): Promise<void> {
        if (this.pinned || this.editing || !this.visible() || editor.document.languageId !== 'ra2-ini') {
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
        this.catalogOrigin = undefined;
        this.changePlan = undefined;
        this.editing = false;
        this.planRevision++;
        if (
            record &&
            this.target &&
            (this.target.uri.toString() !== uri.toString() || this.target.position.line !== position.line)
        ) {
            this.history.push({ ...this.target });
            this.history = this.history.slice(-12);
        }
        this.target = { uri, position, resource };
        if (
            record &&
            this.current?.inspection.map &&
            this.current.origin.toString() === uri.toString() &&
            vscode.workspace.textDocuments.some(
                (document) =>
                    document.uri.toString() === uri.toString() &&
                    document.version === this.current!.inspection.map!.version
            )
        ) {
            return;
        }
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
        if (this.catalogOrigin && this.visible() && !this.editing) {
            void this.browseObjects(this.catalogOrigin, this.catalogScope);
            return;
        }
        if (this.target && this.visible() && !this.editing) {
            void this.inspect(this.target.uri, this.target.position, this.target.resource, false);
        }
    }
    public async browseObjects(origin: vscode.Uri, scope = 'game'): Promise<void> {
        this.catalogScope = scope;
        this.planRevision++;
        this.editing = false;
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.cancellation = new vscode.CancellationTokenSource();
        const revision = ++this.revision;
        this.catalogOrigin = origin;
        this.changePlan = undefined;
        this.pinned = true;
        this.loading = true;
        this.error = undefined;
        this.send();
        try {
            const session = await this.service.catalog(origin, this.cancellation.token);
            session.inspection.catalogScope = scope;
            session.inspection.favoriteObjects = this.preferences?.get<string[]>(
                'catalogFavorites:' + this.service.resources.projectRoot(origin).toString()
            );
            if (scope === 'overview') {
                const index = await this.service.resources.describeIndex(origin);
                const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', origin);
                const counts: Record<string, number> = {};
                for (const object of session.objects!.values()) {
                    const group = catalogGroup(object);
                    counts[group] = (counts[group] ?? 0) + 1;
                }
                const documents = this.service.ini.documents(origin).map((document) => {
                    const id = randomUUID();
                    session.links.set(id, new vscode.Location(document.uri, new vscode.Position(0, 0)));
                    return { id, label: this.service.resources.label(origin, document.uri) };
                });
                session.inspection.project = {
                    root: this.service.resources.projectRoot(origin).fsPath,
                    files: index.files,
                    archives: index.archives,
                    errors: index.errors,
                    counts,
                    documents,
                    configuration: this.configuration.describe(origin, ['loading', 'resources', 'dictionary', 'editing', 'maps'], this.configurationScope),
                };
                this.configurationScope = session.inspection.project.configuration!.scope;
                session.inspection.owner = localize('workbench.projectSettings', 'Project overview and settings');
                session.inspection.objects = undefined;
            }
            if (revision === this.revision) {
                this.current = session;
            }
        } catch (error) {
            if (revision === this.revision) {
                this.error = error instanceof Error ? error.message : String(error);
            }
        } finally {
            if (revision === this.revision) {
                this.loading = false;
                this.send();
            }
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
            active?: boolean;
            value?: string | null;
            ids?: string[];
            key?: string;
            operation?: string;
            request?: number;
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
            this.editing = false;
            this.changePlan = undefined;
            this.planRevision++;
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
        if (current.inspection.project && await configurationMessage({
            service: this.configuration, origin: current.origin, root: this.service.resources.projectRoot(current.origin), scope: this.configurationScope,
            groups: ['loading', 'resources', 'dictionary', 'editing', 'maps'],
            setScope: scope => { this.configurationScope = scope; },
            post: message => { void this.webview.postMessage(message); },
            refresh: () => this.refresh(), editing: active => { this.editing = active; },
        }, message)) { return; }
        if (data.type === 'check-center') { await vscode.commands.executeCommand('ra2-ini-intellisense.checkCenter', current.origin); return; }
        if (data.type === 'dictionary-update') { await vscode.commands.executeCommand('ra2-ini-intellisense.downloadDictionary', current.origin, this.configurationScope ?? (vscode.workspace.getWorkspaceFolder(current.origin) ? 'folder' : 'user')); this.refresh(); return; }
        if (data.type === 'native-settings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Astralette.ra2-ini-intellisense'); return; }

        if (
            data.type === 'save-favorites' &&
            this.preferences &&
            current.objects &&
            Array.isArray(data.ids) &&
            data.ids.length <= 10000 &&
            data.ids.every((id) => typeof id === 'string' && id.length <= 512)
        ) {
            const key = 'catalogFavorites:' + this.service.resources.projectRoot(current.origin).toString();
            const favorites = [...new Set(data.ids)];
            if (JSON.stringify(this.preferences.get(key)) !== JSON.stringify(favorites)) {
                await this.preferences.update(key, favorites);
            }
            return;
        }
        if (
            data.type === 'remember-catalog-scope' &&
            typeof data.value === 'string' &&
            ['game', 'all', ...CATALOG_GROUPS].includes(data.value)
        ) {
            this.catalogScope = data.value;
            current.inspection.catalogScope = data.value;
        } else if (
            data.type === 'catalog-scope' &&
            typeof data.value === 'string' &&
            ['game', 'all', 'favorites', 'overview', ...CATALOG_GROUPS].includes(data.value)
        ) {
            await this.browseObjects(current.origin, data.value);
        } else if (data.type === 'configure-map-renderer') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense.maps');
        } else if (data.type === 'render-map' && current.inspection.map) {
            if (this.loading) {
                return;
            }
            if (!vscode.workspace.isTrusted) {
                throw new Error(
                    localize('workbench.mapTrust', 'Trust this workspace before running an external map renderer.')
                );
            }
            const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', current.origin);
            const options = configuration.get<MapRendererOptions>('maps.renderer');
            if (!options?.executable || !options.mixDirectory) {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense.maps');
                throw new Error(
                    localize(
                        'workbench.mapRendererConfiguration',
                        'Configure an absolute map renderer executable and game MIX directory first.'
                    )
                );
            }
            const document = await vscode.workspace.openTextDocument(current.origin),
                version = document.version;
            if (this.current !== current) {
                return;
            }
            const renderRevision = this.revision;
            this.loading = true;
            this.send();
            try {
                const bytes = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: localize('workbench.renderMap', 'Render current map'),
                        cancellable: true,
                    },
                    async (progress, token) => {
                        const cancellation = new vscode.CancellationTokenSource();
                        const disposables = [
                            token.onCancellationRequested(() => cancellation.cancel()),
                            this.cancellation.token.onCancellationRequested(() => cancellation.cancel()),
                        ];
                        try {
                            return await renderMap(
                                document.getText(),
                                {
                                    ...options,
                                    modDirectories: options.modDirectories ?? [],
                                    rulesFiles: options.rulesFiles ?? [],
                                    artFiles: options.artFiles ?? [],
                                    extraMixes: options.extraMixes ?? [],
                                },
                                cancellation.token,
                                (message) => progress.report({ message })
                            );
                        } finally {
                            disposables.forEach((item) => item.dispose());
                            cancellation.dispose();
                        }
                    }
                );
                if (this.current !== current || this.revision !== renderRevision) {
                    return;
                }
                if (document.version !== version) {
                    throw new Error(
                        localize(
                            'workbench.staleEdit',
                            'The document changed. Refresh the preview before applying this edit.'
                        )
                    );
                }
                current.inspection.map.preview = Buffer.from(bytes).toString('base64');
                current.inspection.map.rendered = true;
                current.inspection.map.note = localize(
                    'workbench.renderedMap',
                    'Rendered from the current map text with the configured game resources.'
                );
                current.inspection.mediaRevision = (current.inspection.mediaRevision ?? 0) + 1;
            } finally {
                if (this.revision === renderRevision) {
                    this.loading = false;
                    this.send();
                }
            }
        } else if (data.type === 'background-file') {
            const files = await vscode.window.showOpenDialog({
                canSelectMany: false,
                title: localize('workbench.chooseBackground', 'Choose background image'),
                filters: {
                    [localize('workbench.backgroundImage', 'Image background')]: ['png', 'jpg', 'jpeg', 'webp'],
                },
            });
            if (!files?.[0]) {
                return;
            }
            const mime: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
            };
            const type = mime[path.posix.extname(files[0].path).toLowerCase()];
            const stat = await vscode.workspace.fs.stat(files[0]);
            if (!type || stat.size > 8 * 1024 * 1024) {
                throw new Error(
                    localize('workbench.backgroundLimit', 'Choose a PNG, JPEG or WebP image smaller than 8 MiB.')
                );
            }
            const bytes = await vscode.workspace.fs.readFile(files[0]);
            void this.webview.postMessage({
                type: 'background-file',
                bytes: Buffer.from(bytes).toString('base64'),
                mime: type,
                name: path.posix.basename(files[0].path),
            });
        } else if (data.type === 'editing') {
            this.editing = data.active === true;
            if (!this.editing) {
                this.changePlan = undefined;
                this.planRevision++;
            }
        } else if (
            data.type === 'property-edit' &&
            data.id &&
            (typeof data.value === 'string' || data.value === null)
        ) {
            const target = current.propertyEdits?.get(data.id);
            if (!target) {
                return;
            }
            await applyPropertyChanges([{ target, value: data.value }]);
            this.editing = false;
            this.refresh();
        } else if (data.type === 'objects') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.browseObjects', current.origin);
        } else if (data.type === 'configure-project') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.configureProject', current.origin);
        } else if (data.type === 'inspect-object' && data.id) {
            const target = current.links.get(data.id);
            if (target && current.objects?.has(data.id)) {
                await vscode.commands.executeCommand(
                    'ra2-ini-intellisense.inspect',
                    target.uri.toString(),
                    target.range.start.line,
                    0
                );
            }
        } else if (data.type === 'compare-objects' && Array.isArray(data.ids)) {
            const objects = [...new Set(data.ids)]
                .slice(0, 8)
                .map((id) => current.objects?.get(id))
                .filter((item) => !!item);
            const keys = [...new Set(objects.flatMap((object) => [...object.properties.keys()]))].sort();
            void this.webview.postMessage({
                type: 'object-comparison',
                inspection: current.inspection.id,
                names: objects.map((object) => object.name),
                rows: keys.map((key) => ({
                    key,
                    values: objects.map((object) => {
                        const value = object.properties.get(key)?.effective;
                        return {
                            value: value?.value ?? '',
                            inherited: value?.inherited ?? false,
                            source: value
                                ? value.section +
                                  ' · ' +
                                  this.service.resources.label(current.origin, value.uri) +
                                  ':' +
                                  (value.line + 1)
                                : '',
                        };
                    }),
                })),
            });
        } else if (
            data.type === 'batch-plan' &&
            Array.isArray(data.ids) &&
            typeof data.key === 'string' &&
            typeof data.value === 'string'
        ) {
            const revision = ++this.planRevision;
            this.changePlan = undefined;
            this.editing = true;
            this.error = undefined;
            this.send();
            if (!current.isCurrent?.()) {
                throw new Error(
                    localize(
                        'workbench.staleEdit',
                        'The document changed. Refresh the preview before applying this edit.'
                    )
                );
            }
            const ids = [...new Set(data.ids)];
            if (!ids.length || ids.length > 1000 || !['set', 'add', 'percent'].includes(data.operation ?? '')) {
                throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
            }
            const changes: PropertyChange[] = [];
            const rows: { name: string; before: string; after: string; source: string }[] = [];
            for (const id of ids) {
                const object = current.objects?.get(id);
                if (!object || /^\$?inherits$/i.test(data.key)) {
                    throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
                }
                const before = object.properties.get(data.key.toLowerCase());
                const { definition, limits, strings } = this.service.propertyDefinition(object.type, data.key);
                if (!before && !definition) {
                    throw new Error(
                        localize(
                            'workbench.unknownProperty',
                            'The property is neither declared on the object nor defined in its dictionary: {0}',
                            data.key
                        )
                    );
                }
                const document = await vscode.workspace.openTextDocument(object.source.document.uri);
                if (document.getText() !== object.source.document.content) {
                    throw new Error(
                        localize(
                            'workbench.staleEdit',
                            'The document changed. Refresh the preview before applying this edit.'
                        )
                    );
                }
                let value = data.value;
                if (data.operation !== 'set') {
                    const old = Number(before?.effective.value),
                        amount = Number(data.value);
                    if (
                        !before?.effective.value.trim() ||
                        !data.value.trim() ||
                        !Number.isFinite(old) ||
                        !Number.isFinite(amount)
                    ) {
                        throw new Error(
                            localize(
                                'workbench.invalidPropertyValue',
                                'The value does not satisfy the property type or range: {0}',
                                object.name + '.' + data.key
                            )
                        );
                    }
                    const result = data.operation === 'add' ? old + amount : old * (1 + amount / 100);
                    value = String(
                        ['int', 'integer'].includes(definition?.type.toLowerCase() ?? '')
                            ? Math.round(result)
                            : Number(result.toPrecision(12))
                    );
                }
                changes.push({
                    value,
                    target: {
                        uri: document.uri,
                        version: document.version,
                        section: object.name,
                        sectionLine: object.source.section.startLine,
                        key: before?.effective.key ?? data.key,
                        valueType: definition?.type,
                        minimum: limits?.min,
                        maximum: limits?.max,
                        allowedValues: strings?.limitIn,
                        caseSensitive: strings?.caseSensitive,
                    },
                });
                rows.push({
                    name: object.name,
                    before: before?.effective.value ?? '',
                    after: value,
                    source: this.service.resources.label(current.origin, document.uri),
                });
            }
            await preparePropertyChanges(changes);
            if (revision !== this.planRevision || current !== this.current) {
                return;
            }
            if (!current.isCurrent()) {
                throw new Error(
                    localize(
                        'workbench.staleEdit',
                        'The document changed. Refresh the preview before applying this edit.'
                    )
                );
            }
            this.changePlan = { id: randomUUID(), changes };
            this.editing = true;
            void this.webview.postMessage({
                type: 'batch-preview',
                inspection: current.inspection.id,
                id: this.changePlan.id,
                rows,
                request: data.request,
            });
        } else if (
            data.type === 'batch-apply' &&
            this.changePlan &&
            typeof data.id === 'string' &&
            data.id === this.changePlan.id
        ) {
            await applyPropertyChanges(this.changePlan.changes, current.isCurrent);
            this.changePlan = undefined;
            this.editing = false;
            this.refresh();
        } else if (
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
        this.planRevision++;
        this.revision++;
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.disposables.forEach((item) => item.dispose());
        this.current = undefined;
        this.history = [];
        this.changePlan = undefined;
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
    private autoRevealing = false;
    private revealErrorReported = false;
    private readonly resolved = new vscode.EventEmitter<void>();
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
                        !this.autoRevealing &&
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
                                this.autoRevealing = true;
                                try {
                                    await this.revealInspector(true);
                                    this.autoRevealed = true;
                                } finally {
                                    this.autoRevealing = false;
                                }
                            })
                            .catch((error) => {
                                console.debug('[Workbench] Auto reveal unavailable', error);
                                if (!this.revealErrorReported) {
                                    this.revealErrorReported = true;
                                    void this.reportRevealError(error);
                                }
                            })
                            .finally(() => cancellation.dispose());
                    }
                }
            }, 140);
        };
        this.disposables.push(
            vscode.commands.registerCommand('ra2-ini-intellisense.previewMap', async (uri?: vscode.Uri) => {
                const origin = commandOrigin(uri);
                if (!origin || !/\.(map|mpr|yrm)$/i.test(origin.path)) {
                    return;
                }
                const inspector = await this.revealInspector(false);
                inspector.pinned = true;
                await inspector.inspect(origin, new vscode.Position(0, 0));
            }),
            vscode.commands.registerCommand('ra2-ini-intellisense.browseObjects', (uri?: vscode.Uri, scope?: string) =>
                this.openProject(uri, scope)
            ),
            vscode.commands.registerCommand('ra2-ini-intellisense.projectOverview', (uri?: vscode.Uri) =>
                this.openProject(uri, 'overview')
            ),
            vscode.commands.registerCommand('ra2-ini-intellisense.configureFileCategory', async (value?: unknown) => {
                let origin = commandOrigin(value);
                if (!origin) { return; }
                if (!/\.(ini|map|mpr|yrm)$/i.test(origin.path)) {
                    const files = await service.resources.listDocuments(origin);
                    const chosen = await vscode.window.showQuickPick(files.map(file => ({ label: vscode.workspace.asRelativePath(file.uri), uri: file.uri })), { title: localize('workbench.configureFileCategory', 'Set INI file category') });
                    if (!chosen) { return; } origin = chosen.uri;
                }
                const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', origin);
                const rules = configuration.get<Record<string, string[]>>('indexing.fileCategories', {});
                const selected = await vscode.window.showQuickPick([{ label: localize('workbench.automatic', 'Automatic'), category: undefined }, ...Object.keys(rules).map(category => ({ label: category, category }))], { title: localize('workbench.configureFileCategory', 'Set INI file category'), placeHolder: vscode.workspace.asRelativePath(origin) });
                if (!selected) { return; }
                const target = vscode.workspace.getWorkspaceFolder(origin) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
                const details = configuration.inspect<Record<string, string>>('indexing.fileOverrides');
                const overrides = { ...(target === vscode.ConfigurationTarget.WorkspaceFolder ? details?.workspaceFolderValue : details?.globalValue) };
                const relative = vscode.workspace.asRelativePath(origin, false).replace(/\\/g, '/');
                if (selected.category) { overrides[relative] = selected.category; } else { delete overrides[relative]; }
                await configuration.update('indexing.fileOverrides', Object.keys(overrides).length ? overrides : undefined, target);
            }),
            vscode.commands.registerCommand('ra2-ini-intellisense.configureProject', async (uri?: vscode.Uri) => {
                const origin = commandOrigin(uri);
                if (!origin || !vscode.workspace.workspaceFolders?.length) {
                    return;
                }
                await service.ini.load(origin);
                const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', origin);
                const previous = configuration.get<Record<string, string[]>>('project.entryPoints', {});
                const root = service.resources.projectRoot(origin);
                const files = await service.resources.listDocuments(origin);
                const choices = files
                    .filter((file) => /\.ini$/i.test(file.name))
                    .map((file) => {
                        const category = service.ini.category(file.uri);
                        const relative = file.uri.path.startsWith(root.path + '/')
                            ? file.uri.path.slice(root.path.length + 1)
                            : file.name;
                        return {
                            label: relative,
                            description: category,
                            category,
                            relative,
                            picked:
                                previous[category]?.some((item) => item.toLowerCase() === relative.toLowerCase()) ??
                                false,
                        };
                    })
                    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
                const chosen = await vscode.window.showQuickPick(choices, {
                    canPickMany: true,
                    title: localize('workbench.projectEntries', 'Project entry INIs'),
                    placeHolder: localize(
                        'workbench.chooseEntries',
                        'Select the root rules, art and sound INIs; included files are followed automatically. Clear all to detect standard project entries.'
                    ),
                });
                if (!chosen) {
                    return;
                }
                const entries: Record<string, string[]> = {};
                chosen.forEach((item) => {
                    (entries[item.category] ??= []).push(item.relative);
                });
                await configuration.update(
                    'project.entryPoints',
                    entries,
                    vscode.workspace.getWorkspaceFolder(origin)
                        ? vscode.ConfigurationTarget.WorkspaceFolder
                        : vscode.ConfigurationTarget.Workspace
                );
            }),
            vscode.window.onDidChangeTextEditorSelection(schedule),
            vscode.window.onDidChangeActiveTextEditor(schedule),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId === 'ra2-ini') {
                    service.ini.documentChanged(event.document);
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
                    try {
                        const inspector = await this.revealInspector(false);
                        this.autoRevealed = true;
                        await inspector.inspect(
                            target,
                            new vscode.Position(
                                Math.max(0, line ?? editor?.selection.active.line ?? 0),
                                Math.max(0, character ?? editor?.selection.active.character ?? 0)
                            )
                        );
                    } catch (error) {
                        await this.reportRevealError(error);
                    }
                }
            ),
            vscode.commands.registerCommand('ra2-ini-intellisense.browseAssets', async (uri?: vscode.Uri) => {
                const origin = commandOrigin(uri);
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

    private async revealInspector(preserveFocus: boolean): Promise<WorkbenchSession> {
        if (!this.view || !this.inspector) {
            await openContributedView(
                vscode.commands,
                WorkbenchController.viewId,
                'ra2-media-workbench',
                preserveFocus
            );
            // Opening a container may return before its webview provider has resolved.
            if (!this.inspector) {
                await new Promise<void>((resolve, reject) => {
                    const listener = this.resolved.event(() => {
                        clearTimeout(timeout);
                        listener.dispose();
                        resolve();
                    });
                    const timeout = setTimeout(() => {
                        listener.dispose();
                        reject(
                            new Error(
                                localize(
                                    'workbench.viewTimeout',
                                    'The asset workbench did not finish opening. Reload the window and try again.'
                                )
                            )
                        );
                    }, 15000);
                });
            }
        }
        if (!this.view || !this.inspector) {
            throw new Error(
                localize(
                    'workbench.viewTimeout',
                    'The asset workbench did not finish opening. Reload the window and try again.'
                )
            );
        }
        this.view.show(preserveFocus);
        return this.inspector;
    }

    private async reportRevealError(error: unknown): Promise<void> {
        const reload = localize('workbench.reloadWindow', 'Reload Window');
        const selected = await vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
            reload
        );
        if (selected === reload) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }
    private projectPanels = new Map<string, { panel: vscode.WebviewPanel; session: WorkbenchSession }>();
    private async openProject(uri?: vscode.Uri, scope = 'game'): Promise<void> {
        const origin = commandOrigin(uri);
        if (!origin) {
            return;
        }
        const root = this.service.resources.projectRoot(origin),
            key = root.toString();
        let entry = this.projectPanels.get(key);
        if (!entry) {
            const panel = vscode.window.createWebviewPanel(
                'ra2-object-browser',
                localize('project.title', 'Project workbench') + ' · ' + path.posix.basename(root.path),
                vscode.ViewColumn.Active,
                { retainContextWhenHidden: true }
            );
            const session = new WorkbenchSession(
                panel.webview,
                this.context.extensionUri,
                this.service,
                this.media,
                () => panel.visible,
                this.context.workspaceState
            );
            entry = { panel, session };
            this.projectPanels.set(key, entry);
            this.sessions.add(session);
            panel.onDidDispose(() => {
                this.projectPanels.delete(key);
                this.sessions.delete(session);
                session.dispose();
            });
        }
        entry.panel.reveal(undefined, true);
        await entry.session.browseObjects(origin, scope);
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
        this.resolved.fire();
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
                    this.view = undefined;
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
        this.resolved.dispose();
        this.disposables.forEach((item) => item.dispose());
    }
}
