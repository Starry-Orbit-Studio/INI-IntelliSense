import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { randomBytes, randomUUID } from 'crypto';
import { BrowserLocations, BrowserEntry } from './locations';
import { BrowserTransfers } from './transfers';
import { MixWorkspaceManager } from '../fs/mix-workspace-manager';
import { MixUriCodec } from '../fs/mix-uri-codec';
import { browserLabelDefaults, FileBrowserState, PaneState } from './protocol';
import { CompareService } from '../../compare/compare-service';
import { CompareResult, CompareSource } from '../../compare/types';
import { MediaService } from '../../media/media-service';
import { localize } from '../../i18n';
import { validFileName, validRelativeFileName } from './file-names';

const VIEW = 'ra2-ini-intellisense.files';
const validName = validFileName;
const labels = () =>
    Object.fromEntries(
        Object.entries(browserLabelDefaults).map(([key, value]) => [key, localize('mix.browser.' + key, value)])
    );

/** Custom archive editor and directory browser share host-owned resource tokens, clipboard and transfers. */
export class FileBrowserEditor implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
    public readonly locations: BrowserLocations;
    public readonly transfers: BrowserTransfers;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly panels = new Set<vscode.WebviewPanel>();
    private clipboard: { uris: vscode.Uri[]; cut: boolean } = { uris: [], cut: false };
    private readonly tokens = new Map<string, vscode.Uri>();
    private readonly uriTokens = new Map<string, string>();
    private readonly entryTokens = new Map<string, BrowserEntry>();
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly mix: MixWorkspaceManager,
        private readonly compare: CompareService,
        private readonly media: MediaService
    ) {
        this.locations = new BrowserLocations(mix);
        this.transfers = new BrowserTransfers(this.locations, mix);
        this.compare.reader = this.locations;
        this.subscriptions.push(
            vscode.window.registerCustomEditorProvider(VIEW, this, {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }),
            vscode.window.registerCustomEditorProvider(VIEW + '.alias', this, {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }),
            vscode.commands.registerCommand(
                'ra2-ini-intellisense.browseFiles',
                async (
                    target?: vscode.Uri | { uri?: vscode.Uri; resourceUri?: vscode.Uri },
                    secondary?: vscode.Uri
                ) => {
                    const uri =
                        target instanceof vscode.Uri
                            ? target
                            : (target?.uri ?? target?.resourceUri ?? vscode.workspace.workspaceFolders?.[0]?.uri);
                    if (!uri) {
                        const selection = await this.pick(true);
                        if (selection) {
                            await this.open(selection);
                        }
                    } else {
                        try {
                            await this.open(uri, secondary);
                        } catch (error) {
                            await vscode.window.showErrorMessage(
                                error instanceof Error ? error.message : String(error)
                            );
                        }
                    }
                }
            ),
            vscode.window.tabGroups.onDidChangeTabs((event) => {
                for (const tab of event.opened) {
                    void this.redirectAlias(tab);
                }
            })
        );
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                void this.redirectAlias(tab);
            }
        }
    }
    private async redirectAlias(tab: vscode.Tab): Promise<void> {
        if (!(tab.input instanceof vscode.TabInputText) || !/\.(dll|big)$/i.test(tab.input.uri.path) || tab.isDirty) {
            return;
        }
        const uri = tab.input.uri;
        try {
            if ((await this.locations.isArchive(uri)) && tab.isActive && !tab.isDirty) {
                await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
                if (vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab)) && !tab.isDirty) {
                    await vscode.window.tabGroups.close(tab, true);
                }
            }
        } catch (error) {
            console.error('[MIX alias detection]', error);
        }
    }
    public async open(uri: vscode.Uri, secondary?: vscode.Uri): Promise<void> {
        const stat = await vscode.workspace.fs.stat(uri);
        if (!(stat.type & vscode.FileType.Directory) && uri.scheme !== MixUriCodec.scheme) {
            if (!(await this.locations.isArchive(uri))) {
                throw new Error(localize('mix.browser.invalidArchive', 'This file is not a supported MIX archive.'));
            }
            await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
            return;
        }
        const panel = vscode.window.createWebviewPanel(VIEW, labels().title, vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        const right =
            secondary && !((await this.locations.stat(secondary)).type & vscode.FileType.Directory)
                ? this.locations.archiveRoot(secondary)
                : secondary;
        await this.attach(panel, stat.type & vscode.FileType.Directory ? uri : this.locations.archiveRoot(uri), right);
    }
    public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose() {} };
    }
    public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
        await this.attach(panel, this.locations.archiveRoot(document.uri));
    }
    private async pick(folder: boolean): Promise<vscode.Uri | undefined> {
        return (
            await vscode.window.showOpenDialog({
                canSelectFiles: !folder,
                canSelectFolders: folder,
                canSelectMany: false,
                openLabel: folder ? labels().openFolder : labels().openArchive,
            })
        )?.[0];
    }

    private async attach(panel: vscode.WebviewPanel, initial: vscode.Uri, secondary?: vscode.Uri): Promise<void> {
        this.panels.add(panel);
        const assets = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench'),
            nonce = randomBytes(18).toString('base64');
        panel.webview.options = { enableScripts: true, localResourceRoots: [assets] };
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'files.js')),
            css = panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'files.css'));
        panel.webview.html =
            '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; media-src data:; style-src ' +
            panel.webview.cspSource +
            " 'unsafe-inline'; script-src 'nonce-" +
            nonce +
            '\';"><link rel="stylesheet" href="' +
            css +
            '"></head><body><main id="files"></main><script nonce="' +
            nonce +
            '" src="' +
            script +
            '"></script></body></html>';
        let revision = 0;
        let roots: (vscode.Uri | undefined)[] = [initial, secondary],
            panes: (PaneState | undefined)[] = [],
            ready = false,
            disposed = false,
            busy = false,
            message: string | undefined;
        let previewCancellation: vscode.CancellationTokenSource | undefined;
        let comparison: CompareResult | undefined,
            cancellation: vscode.CancellationTokenSource | undefined,
            refreshTimer: NodeJS.Timeout | undefined;
        const { tokens, uriTokens, entryTokens } = this;
        const histories: vscode.Uri[][] = [[], []],
            futures: vscode.Uri[][] = [[], []];
        const token = (uri: vscode.Uri) => {
            let id = uriTokens.get(uri.toString());
            if (!id) {
                id = randomUUID();
                uriTokens.set(uri.toString(), id);
                tokens.set(id, uri);
            }
            return id;
        };
        const resource = (value: unknown) => {
            const uri = typeof value === 'string' && tokens.get(value);
            if (!uri) {
                throw new Error('Invalid resource token.');
            }
            return uri;
        };
        const selected = (value: unknown) => {
            if (
                !Array.isArray(value) ||
                value.length > 65535 ||
                value.some((id) => typeof id !== 'string' || !entryTokens.has(id))
            ) {
                throw new Error('Invalid selection.');
            }
            return value.map(resource);
        };
        const post = () => {
            if (!ready || disposed) {
                return;
            }
            const counts: Record<string, number> = {};
            comparison?.items.forEach((item) => {
                counts[item.status] = (counts[item.status] ?? 0) + 1;
            });
            const state: FileBrowserState = {
                panes,
                labels: labels(),
                clipboard: this.clipboard.uris.length,
                cut: this.clipboard.cut,
                undo: this.transfers.canUndo,
                busy,
                message,
                compare: comparison ? { counts } : undefined,
            };
            void panel.webview.postMessage({ type: 'state', state });
        };
        const display = (uri: vscode.Uri) => {
            if (uri.scheme !== MixUriCodec.scheme) {
                return uri.fsPath;
            }
            const decoded = MixUriCodec.decode(uri);
            return [
                decoded.containerUri.fsPath,
                ...decoded.nestedChain,
                decoded.virtualPath === '/' ? '' : decoded.virtualPath.slice(1),
            ]
                .filter(Boolean)
                .join(' › ');
        };
        const snapshot = async (uri: vscode.Uri): Promise<PaneState> => {
            const listing = await this.locations.list(uri),
                chain: vscode.Uri[] = [uri];
            while (chain.length < 64) {
                const parent = this.locations.parent(chain[0]);
                if (parent.toString() === chain[0].toString()) {
                    break;
                }
                chain.unshift(parent);
            }
            let rows = listing.entries.map((entry) => {
                const id = token(entry.uri);
                entryTokens.set(id, entry);
                const item = comparison?.items.find(
                    (item) =>
                        item.left?.uri.toString() === entry.uri.toString() ||
                        item.right?.uri.toString() === entry.uri.toString()
                );
                return {
                    token: id,
                    name: entry.name,
                    size: entry.size,
                    directory: entry.directory,
                    archive: entry.archive,
                    id:
                        entry.id !== undefined
                            ? '0x' + entry.id.toString(16).toUpperCase().padStart(8, '0')
                            : undefined,
                    status: item?.status,
                };
            });
            // Sniff likely aliases and unknown hashes in bounded batches; ordinary media need no probe.
            const candidates = rows.filter((row) => !row.directory && /\.(mix|dll|big)$/i.test(row.name));
            for (let at = 0; at < candidates.length; at += 8) {
                await Promise.all(
                    candidates.slice(at, at + 8).map(async (row) => {
                        row.archive = await this.locations.isArchive(resource(row.token));
                        entryTokens.get(row.token)!.archive = row.archive;
                    })
                );
            }
            if (comparison) {
                const side = uri.toString() === comparison.left.rootUri.toString() ? 'left' : 'right';
                rows = comparison.items
                    .filter((item) => item[side]?.entryType === 'file')
                    .map((item) => {
                        const source = item[side]!,
                            id = token(source.uri);
                        entryTokens.set(id, {
                            uri: source.uri,
                            name: item.relativePath,
                            size: source.size,
                            directory: false,
                            archive: false,
                        });
                        return {
                            token: id,
                            name: item.relativePath,
                            size: source.size,
                            directory: false,
                            archive: /\.mix$/i.test(item.relativePath),
                            id: undefined,
                            status: item.status,
                            diff: !!(
                                item.left &&
                                item.right &&
                                (item.left.likelyText ||
                                    /\.(ini|map|mpr|yrm|txt|llf|json|xml|csv|lua|ya?ml|md)$/i.test(item.relativePath))
                            ),
                        };
                    });
            }
            return {
                revision,
                location: token(uri),
                label: display(uri),
                parent: token(this.locations.parent(uri)),
                crumbs: chain.map((crumb) => ({
                    token: token(crumb),
                    label:
                        crumb.scheme === MixUriCodec.scheme && crumb.path === '/'
                            ? display(crumb).split(' › ').at(-1)!
                            : path.posix.basename(crumb.path) || crumb.fsPath,
                })),
                rows,
                readonly: listing.readonly,
                archive: uri.scheme === MixUriCodec.scheme,
            };
        };
        const refresh = async () => {
            if (!ready || disposed) {
                return;
            }
            revision++;
            this.locations.clear();
            panes = await Promise.all(roots.map((root) => (root ? snapshot(root) : undefined)));
            post();
            updateWatches();
        };
        const navigate = async (index: number, uri: vscode.Uri, saveHistory = true) => {
            if (saveHistory && roots[index] && roots[index]!.toString() !== uri.toString()) {
                histories[index].push(roots[index]!);
                futures[index] = [];
            }
            roots[index] = uri;
            comparison = undefined;
            await refresh();
        };
        const fail = (error: unknown) => {
            if (error instanceof vscode.CancellationError) {
                message = undefined;
            } else {
                console.error('[File browser]', error);
                message = error instanceof Error ? error.message : String(error);
            }
            post();
        };
        const transfer = async (
            sources: vscode.Uri[],
            target: vscode.Uri,
            move = false,
            relative?: ReadonlyMap<string, string>
        ) => {
            const plan = await this.transfers.plan(sources, target, move, cancellation?.token, relative);
            if (await this.transfers.resolve(plan)) {
                await this.transfers.execute(plan, cancellation?.token);
                comparison = undefined;
            }
        };
        const renderPreview = async (id: string, previewToken: vscode.CancellationToken) => {
            const uri = resource(id),
                entry = entryTokens.get(id);
            if (!entry || entry.directory || entry.archive || previewToken.isCancellationRequested) {
                return;
            }
            if (entry.size > 16 * 1024 * 1024) {
                await panel.webview.postMessage({
                    type: 'preview',
                    token: id,
                    name: entry.name,
                    hint: localize(
                        'mix.browser.largePreview',
                        'Open this file in its editor to preview it (larger than 16 MiB).'
                    ),
                });
                return;
            }
            const slice = await this.locations.resourceRange(uri);
            if (slice) {
                this.media.resources.registerSlice(uri, slice);
            }
            const candidate = { uri, name: entry.name, priority: 0, source: display(uri) };
            if (/\.(wav|mp3|ogg|flac)$/i.test(entry.name)) {
                const audio = await this.media.load(candidate, {}, previewToken);
                if (audio.kind === 'audio' && !previewToken.isCancellationRequested) {
                    await panel.webview.postMessage({
                        type: 'preview',
                        token: id,
                        name: entry.name,
                        audio:
                            'data:audio/' +
                            (/\.mp3$/i.test(entry.name) ? 'mpeg' : entry.name.split('.').at(-1)!.toLowerCase()) +
                            ';base64,' +
                            audio.bytes,
                    });
                }
                return;
            }
            const png = await this.media.thumbnail(candidate, previewToken);
            if (previewToken.isCancellationRequested) {
                return;
            }
            if (png) {
                await panel.webview.postMessage({
                    type: 'preview',
                    token: id,
                    name: entry.name,
                    image: 'data:image/png;base64,' + Buffer.from(png).toString('base64'),
                });
            } else {
                const sample = await this.locations.readRange(uri, 0, Math.min(entry.size, 4096)),
                    text = new TextDecoder().decode(sample);
                await panel.webview.postMessage({
                    type: 'preview',
                    token: id,
                    name: entry.name,
                    text: !sample.includes(0)
                        ? text
                        : [...sample.subarray(0, 256)].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
                    hint:
                        entry.size > sample.length
                            ? localize(
                                  'mix.browser.partialPreview',
                                  'Showing the beginning of the file. Open it to see all content.'
                              )
                            : undefined,
                });
            }
            return;
        };
        const listener = panel.webview.onDidReceiveMessage(async (raw) => {
            if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
                return;
            }
            if (raw.type === 'probe') {
                if (!Array.isArray(raw.tokens) || raw.tokens.length > 48) {
                    return;
                }
                const current = revision;
                void Promise.all(
                    raw.tokens
                        .filter((id: unknown) => typeof id === 'string' && entryTokens.has(id))
                        .map(async (id: string) => ({
                            token: id,
                            archive: await this.locations.isArchive(resource(id)),
                        }))
                )
                    .then((results) => {
                        if (disposed || current !== revision) {
                            return;
                        }
                        for (const result of results) {
                            entryTokens.get(result.token)!.archive = result.archive;
                            panes.forEach((pane) => {
                                const row = pane?.rows.find((row) => row.token === result.token);
                                if (row) {
                                    row.archive = result.archive;
                                }
                            });
                        }
                        void panel.webview.postMessage({ type: 'classification', results });
                    })
                    .catch((error) => console.error('[MIX entry identification]', error));
                return;
            }
            if (raw.type === 'preview') {
                previewCancellation?.cancel();
                const current = new vscode.CancellationTokenSource();
                previewCancellation = current;
                void renderPreview(raw.token, current.token)
                    .catch((error) => {
                        if (!current.token.isCancellationRequested) {
                            void panel.webview.postMessage({
                                type: 'preview',
                                token: raw.token,
                                name: entryTokens.get(raw.token)?.name ?? '',
                                hint: error instanceof Error ? error.message : String(error),
                            });
                        }
                    })
                    .finally(() => {
                        current.dispose();
                        if (previewCancellation === current) {
                            previewCancellation = undefined;
                        }
                    });
                return;
            }
            if (raw.type === 'cancel') {
                cancellation?.cancel();
                return;
            }
            if (busy) {
                return;
            }
            const index = raw.pane === 1 ? 1 : 0;
            busy = true;
            message = undefined;
            cancellation = new vscode.CancellationTokenSource();
            post();
            try {
                switch (raw.type) {
                    case 'ready':
                        ready = true;
                        await refresh();
                        break;
                    case 'refresh':
                        comparison = undefined;
                        await refresh();
                        break;
                    case 'pick': {
                        const chosen = await this.pick(raw.folder === true);
                        if (!chosen) {
                            break;
                        }
                        const uri = raw.folder
                            ? chosen
                            : (await this.locations.isArchive(chosen))
                              ? this.locations.archiveRoot(chosen)
                              : undefined;
                        if (!uri) {
                            throw new Error(
                                localize('mix.browser.invalidArchive', 'This file is not a supported MIX archive.')
                            );
                        }
                        await navigate(index, uri);
                        break;
                    }
                    case 'navigate': {
                        const uri = resource(raw.token),
                            entry = entryTokens.get(raw.token);
                        await navigate(index, entry && !entry.directory ? this.locations.archiveRoot(uri) : uri);
                        break;
                    }
                    case 'back':
                    case 'forward': {
                        const from = raw.type === 'back' ? histories[index] : futures[index],
                            to = raw.type === 'back' ? futures[index] : histories[index],
                            uri = from.pop();
                        if (uri) {
                            if (roots[index]) {
                                to.push(roots[index]!);
                            }
                            await navigate(index, uri, false);
                        }
                        break;
                    }
                    case 'clipboard':
                        this.clipboard = { uris: selected(raw.tokens), cut: raw.cut === true };
                        this.panels.forEach((other) => {
                            if (other !== panel) {
                                void other.webview.postMessage({
                                    type: 'clipboard',
                                    count: this.clipboard.uris.length,
                                    cut: this.clipboard.cut,
                                });
                            }
                        });
                        break;
                    case 'paste':
                        if (roots[index] && this.clipboard.uris.length) {
                            await transfer(this.clipboard.uris, roots[index]!, this.clipboard.cut);
                            if (this.clipboard.cut) {
                                this.clipboard = { uris: [], cut: false };
                            }
                            await refresh();
                        }
                        break;
                    case 'transfer': {
                        const target = raw.target ? resource(raw.target) : roots[index];
                        if (target) {
                            const entry = raw.target && entryTokens.get(raw.target);
                            await transfer(
                                selected(raw.tokens),
                                entry && entry.archive ? this.locations.archiveRoot(target) : target,
                                raw.move === true
                            );
                            await refresh();
                        }
                        break;
                    }
                    case 'import': {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: true,
                            canSelectMany: true,
                            openLabel: labels().import,
                        });
                        if (picked?.length && roots[index]) {
                            await transfer(picked, roots[index]!);
                            await refresh();
                        }
                        break;
                    }
                    case 'upload': {
                        if (
                            !Array.isArray(raw.files) ||
                            raw.files.length > 1024 ||
                            raw.files.some(
                                (file: unknown) =>
                                    !file ||
                                    typeof file !== 'object' ||
                                    typeof (file as { name?: unknown }).name !== 'string' ||
                                    !validRelativeFileName((file as { name: string }).name) ||
                                    typeof (file as { content?: unknown }).content !== 'string'
                            ) ||
                            (raw.directories !== undefined &&
                                (!Array.isArray(raw.directories) ||
                                    raw.directories.some(
                                        (name: unknown) => typeof name !== 'string' || !validRelativeFileName(name)
                                    )))
                        ) {
                            throw new Error('Invalid upload.');
                        }
                        if (
                            raw.files.reduce((sum: number, file: { content: string }) => sum + file.content.length, 0) >
                            128 * 1024 * 1024
                        ) {
                            throw new Error(
                                localize(
                                    'mix.browser.largeUpload',
                                    'Use Import files for transfers larger than 96 MiB.'
                                )
                            );
                        }
                        const target = raw.target ? resource(raw.target) : roots[index];
                        if (!target) {
                            break;
                        }
                        const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ra2-mix-import-'));
                        try {
                            for (const name of raw.directories ?? []) {
                                await fs.mkdir(path.join(staging, name), { recursive: true });
                            }
                            for (const file of raw.files) {
                                const uri = vscode.Uri.file(path.join(staging, file.name));
                                await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
                                await fs.writeFile(uri.fsPath, Buffer.from(file.content, 'base64'), { flag: 'wx' });
                            }
                            const uris = (await fs.readdir(staging)).map((name) =>
                                vscode.Uri.file(path.join(staging, name))
                            );
                            const entry = raw.target && entryTokens.get(raw.target);
                            await transfer(uris, entry && entry.archive ? this.locations.archiveRoot(target) : target);
                            await refresh();
                        } finally {
                            await fs.rm(staging, { recursive: true, force: true });
                        }
                        break;
                    }
                    case 'export': {
                        const target = await this.pick(true);
                        if (target) {
                            await transfer(selected(raw.tokens), target);
                            await refresh();
                        }
                        break;
                    }
                    case 'remove': {
                        const sources = selected(raw.tokens),
                            confirm = localize(
                                'mix.browser.deleteConfirm',
                                'Delete {0} selected items? A recovery backup will be kept.',
                                sources.length
                            ),
                            remove = labels().remove;
                        if (
                            sources.length &&
                            (await vscode.window.showWarningMessage(confirm, { modal: true }, remove)) === remove
                        ) {
                            await this.transfers.remove(sources);
                            comparison = undefined;
                            await refresh();
                        }
                        break;
                    }
                    case 'rename':
                    case 'create': {
                        const source = raw.type === 'rename' ? selected(raw.tokens)[0] : undefined,
                            current = source ? path.posix.basename(source.path) : 'new.mix';
                        const name = await vscode.window.showInputBox({
                            title: raw.type === 'rename' ? labels().rename : labels().create,
                            value: current,
                            validateInput: (value) =>
                                validName(value)
                                    ? undefined
                                    : localize('mix.browser.invalidName', 'Invalid destination filename: {0}', value),
                        });
                        if (name && roots[index]) {
                            const target = this.locations.child(
                                source ? this.locations.parent(source) : roots[index]!,
                                name
                            );
                            if (source) {
                                await this.transfers.rename(source, target);
                            } else {
                                await this.transfers.createArchive(target);
                            }
                            comparison = undefined;
                            await refresh();
                        }
                        break;
                    }
                    case 'undo':
                        await this.transfers.undo();
                        comparison = undefined;
                        await refresh();
                        break;
                    case 'diff': {
                        const uri = resource(raw.token ?? raw.tokens?.[0]),
                            item = comparison?.items.find(
                                (item) =>
                                    item.left?.uri.toString() === uri.toString() ||
                                    item.right?.uri.toString() === uri.toString()
                            );
                        if (
                            item?.left &&
                            item.right &&
                            (item.left.likelyText ||
                                /\.(ini|map|mpr|yrm|txt|llf|json|xml|csv|lua|ya?ml|md)$/i.test(item.relativePath))
                        ) {
                            await vscode.commands.executeCommand(
                                'vscode.diff',
                                item.left.uri,
                                item.right.uri,
                                item.relativePath
                            );
                        }
                        break;
                    }
                    case 'open': {
                        const uri = resource(raw.token);
                        if (await this.locations.isArchive(uri)) {
                            await navigate(index, this.locations.archiveRoot(uri));
                            break;
                        }
                        await vscode.commands.executeCommand(
                            /\.(shp|tem|sno|urb|ubn|des|lun|pcx|pal|vxl|hva|wav|mp3|ogg|flac)$/i.test(uri.path)
                                ? 'vscode.openWith'
                                : 'vscode.open',
                            uri,
                            ...(/\.(shp|tem|sno|urb|ubn|des|lun|pcx|pal|vxl|hva|wav|mp3|ogg|flac)$/i.test(uri.path)
                                ? ['ra2-resource-preview.viewer']
                                : [])
                        );
                        break;
                    }
                    case 'compare': {
                        if (!roots[0] || !roots[1]) {
                            break;
                        }
                        const source = (uri: vscode.Uri): CompareSource => ({
                            kind: uri.scheme === MixUriCodec.scheme ? 'mix' : 'directory',
                            rootUri: uri,
                            openUri: uri,
                            label: display(uri),
                            description: '',
                        });
                        comparison = await this.compare.compare(
                            source(roots[0]),
                            source(roots[1]),
                            undefined,
                            cancellation.token
                        );
                        await refresh();
                        break;
                    }
                    case 'clearCompare':
                        comparison = undefined;
                        await refresh();
                        break;
                    case 'sync': {
                        if (!comparison || !roots[1 - index]) {
                            break;
                        }
                        const choices = selected(raw.tokens),
                            keys = new Set(choices.map((uri) => uri.toString()));
                        const items = comparison.items.filter(
                            (item) =>
                                item.status !== 'identical' &&
                                item.entryType === 'file' &&
                                keys.has((index ? item.right : item.left)?.uri.toString() ?? '')
                        );
                        const uris = items.map((item) => (index ? item.right : item.left)!.uri),
                            relative = new Map(
                                items.map((item) => [
                                    (index ? item.right : item.left)!.uri.toString(),
                                    item.relativePath,
                                ])
                            );
                        await transfer(uris, roots[1 - index]!, false, relative);
                        await refresh();
                        break;
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                cancellation.dispose();
                cancellation = undefined;
                busy = false;
                post();
            }
        });
        const changed = () => {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
                if (!busy) {
                    comparison = undefined;
                    void refresh().catch(fail);
                }
            }, 250);
        };
        let watches: vscode.Disposable[] = [],
            watchKey = '';
        const updateWatches = () => {
            const key = roots.map((root) => root?.toString() ?? '').join('|') + (!!comparison ? ':compare' : '');
            if (key === watchKey) {
                return;
            }
            watches.forEach((watch) => watch.dispose());
            watches = [];
            watchKey = key;
            for (const root of roots) {
                if (!root) {
                    continue;
                }
                const physical = root.scheme === MixUriCodec.scheme ? MixUriCodec.decode(root).containerUri : root;
                if (physical.scheme !== 'file') {
                    continue;
                }
                const base =
                    root.scheme === MixUriCodec.scheme ? vscode.Uri.file(path.dirname(physical.fsPath)) : physical;
                const watch = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(
                        base,
                        root.scheme === MixUriCodec.scheme ? path.basename(physical.fsPath) : comparison ? '**/*' : '*'
                    )
                );
                watches.push(watch, watch.onDidCreate(changed), watch.onDidChange(changed), watch.onDidDelete(changed));
            }
        };
        const listeners = [listener, this.mix.onDidChangeFile(changed)];
        panel.onDidDispose(() => {
            disposed = true;
            clearTimeout(refreshTimer);
            cancellation?.cancel();
            previewCancellation?.cancel();
            listeners.forEach((item) => item.dispose());
            watches.forEach((watch) => watch.dispose());
            this.panels.delete(panel);
            if (!this.panels.size) {
                this.tokens.clear();
                this.uriTokens.clear();
                this.entryTokens.clear();
            }
        });
    }
    public dispose(): void {
        this.subscriptions.forEach((item) => item.dispose());
        this.panels.forEach((panel) => panel.dispose());
    }
}
