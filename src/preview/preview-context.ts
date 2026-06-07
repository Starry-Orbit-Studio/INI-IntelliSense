import * as path from 'path';
import * as vscode from 'vscode';
import { INIManager } from '../parser';
import { localize } from '../i18n';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { decodeLocalText } from '../mix/core/local-encoding';
import { PaletteColor, createGrayscalePalette, readPalette } from './palette-utils';

interface ResourceEntry {
    uri: vscode.Uri;
    name: string;
    extension: string;
    containerKey: string;
}

interface ResolverIndex {
    byLowerName: Map<string, ResourceEntry[]>;
    byExtension: Map<string, ResourceEntry[]>;
    builtForRoot: string;
}

export interface PaletteSelection {
    uri?: vscode.Uri;
    label: string;
    colors: PaletteColor[];
    source: 'auto' | 'manual' | 'fallback';
}

export interface PreviewContextServices {
    iniManager: INIManager;
    extensionUri: vscode.Uri;
}

export class PreviewContext {
    private readonly paletteCache = new Map<string, PaletteColor[]>();
    private readonly resolverCache = new Map<string, ResolverIndex>();

    constructor(private readonly services: PreviewContextServices) {}

    public async resolvePaletteForShp(uri: vscode.Uri): Promise<PaletteSelection> {
        const shpBaseName = basenameWithoutExtension(uri);

        const artDocument = await this.findWorkspaceIniDocument(uri, 'art');
        if (artDocument) {
            const section = artDocument.getSection(shpBaseName);
            if (section) {
                const customPalette = getValueIgnoreCase(section.properties, 'CustomPalette');
                if (customPalette) {
                    const resolved = await this.findPaletteByName(uri, ensurePalExtension(customPalette));
                    if (resolved) {
                        return this.createPaletteSelection(resolved, 'auto');
                    }
                }

                if (hasKeyIgnoreCase(section.properties, 'AltPalette')) {
                    const resolved = await this.findPaletteByName(uri, 'unittem.pal');
                    if (resolved) {
                        return this.createPaletteSelection(resolved, 'auto');
                    }
                }

                const paletteValue = getValueIgnoreCase(section.properties, 'Palette');
                if (paletteValue) {
                    const resolved = paletteValue.toLowerCase().endsWith('.pal')
                        ? await this.findPaletteByName(uri, paletteValue)
                        : await this.findPaletteByWildcard(uri, paletteValue);
                    if (resolved) {
                        return this.createPaletteSelection(resolved, 'auto');
                    }
                }
            }
        }

        const rulesDocument = await this.findWorkspaceIniDocument(uri, 'rules');
        if (rulesDocument) {
            const ownerSectionName = findOwnerSectionByImage(rulesDocument, shpBaseName);
            if (ownerSectionName && isAnimationSection(rulesDocument, ownerSectionName)) {
                const resolved = await this.findPaletteByName(uri, 'anim.pal');
                if (resolved) {
                    return this.createPaletteSelection(resolved, 'auto');
                }
            }
        }

        const sameName = await this.findPaletteByName(uri, `${shpBaseName}.pal`);
        if (sameName) {
            return this.createPaletteSelection(sameName, 'auto');
        }

        const unittem = await this.findPaletteByName(uri, 'unittem.pal');
        if (unittem) {
            return this.createPaletteSelection(unittem, 'auto');
        }

        return {
            label: 'unittem.pal',
            colors: await this.readDefaultUnittemPalette(),
            source: 'fallback',
        };
    }

    public async choosePalette(uri: vscode.Uri): Promise<PaletteSelection | undefined> {
        const index = await this.getResolverIndex(uri);
        const palettes = prioritizeEntries(index.byExtension.get('.pal') ?? [], uri);
        if (palettes.length === 0) {
            vscode.window.showWarningMessage(localize('preview.palette.notFound', 'No palette files were found in the current workspace.'));
            return undefined;
        }

        const items = palettes.map(entry => ({
            label: entry.name,
            description: describeUri(entry.uri, uri),
            entry,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: localize('preview.palette.pick.title', 'Choose Palette'),
            placeHolder: localize('preview.palette.pick.placeholder', 'Select a palette for the current preview'),
            matchOnDescription: true,
        });
        if (!selected) {
            return undefined;
        }

        return this.createPaletteSelection(selected.entry.uri, 'manual');
    }

    public async readPalette(uri: vscode.Uri): Promise<PaletteColor[]> {
        const key = uri.toString();
        const cached = this.paletteCache.get(key);
        if (cached) {
            return cached;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        const palette = readPalette(bytes);
        this.paletteCache.set(key, palette);
        return palette;
    }

    public async readSiblingBytes(uri: vscode.Uri, siblingName: string): Promise<Uint8Array | undefined> {
        const siblingUri = await this.findSiblingUri(uri, siblingName);
        if (!siblingUri) {
            return undefined;
        }

        try {
            return await vscode.workspace.fs.readFile(siblingUri);
        } catch {
            return undefined;
        }
    }

    public async findSiblingUri(uri: vscode.Uri, siblingName: string): Promise<vscode.Uri | undefined> {
        const siblings = await this.findByName(uri, siblingName);
        const localSibling = siblings.find(entry => sameParent(entry.uri, uri));
        return localSibling?.uri ?? siblings[0]?.uri;
    }

    public clearCaches(): void {
        this.paletteCache.clear();
        this.resolverCache.clear();
    }

    public async readBundledAsset(relativeSegments: string[]): Promise<Uint8Array> {
        const uri = vscode.Uri.joinPath(this.services.extensionUri, ...relativeSegments);
        return vscode.workspace.fs.readFile(uri);
    }

    private async readDefaultUnittemPalette(): Promise<PaletteColor[]> {
        const uri = vscode.Uri.joinPath(this.services.extensionUri, 'assets', 'palettes', 'unittem.pal');
        try {
            return await this.readPalette(uri);
        } catch {
            return createGrayscalePalette();
        }
    }

    private async createPaletteSelection(uri: vscode.Uri, source: 'auto' | 'manual'): Promise<PaletteSelection> {
        return {
            uri,
            label: path.posix.basename(uri.path),
            colors: await this.readPalette(uri),
            source,
        };
    }

    private async findPaletteByWildcard(uri: vscode.Uri, prefix: string): Promise<vscode.Uri | undefined> {
        const index = await this.getResolverIndex(uri);
        const loweredPrefix = prefix.toLowerCase();
        const palettes = prioritizeEntries(index.byExtension.get('.pal') ?? [], uri);
        const match = palettes.find(entry =>
            entry.name.toLowerCase().startsWith(loweredPrefix)
            && entry.name.toLowerCase().endsWith('.pal')
        );
        return match?.uri;
    }

    private async findPaletteByName(uri: vscode.Uri, name: string): Promise<vscode.Uri | undefined> {
        const match = await this.findByName(uri, name);
        return match[0]?.uri;
    }

    private async findByName(uri: vscode.Uri, name: string): Promise<ResourceEntry[]> {
        const index = await this.getResolverIndex(uri);
        const key = path.posix.basename(name).toLowerCase();
        const entries = index.byLowerName.get(key) ?? [];
        return prioritizeEntries(entries, uri);
    }

    private async getResolverIndex(uri: vscode.Uri): Promise<ResolverIndex> {
        const root = this.getSearchRoot(uri);
        const key = root.toString();
        const cached = this.resolverCache.get(key);
        if (cached) {
            return cached;
        }

        const byLowerName = new Map<string, ResourceEntry[]>();
        const byExtension = new Map<string, ResourceEntry[]>();
        const queue: vscode.Uri[] = [root];

        while (queue.length > 0) {
            const current = queue.shift()!;
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(current);
            } catch {
                continue;
            }

            for (const [name, type] of entries) {
                const child = vscode.Uri.joinPath(current, name);
                if (type === vscode.FileType.Directory) {
                    queue.push(child);
                    continue;
                }

                const entry: ResourceEntry = {
                    uri: child,
                    name,
                    extension: path.extname(name).toLowerCase(),
                    containerKey: getContainerKey(child),
                };
                pushIndexed(byLowerName, name.toLowerCase(), entry);
                pushIndexed(byExtension, entry.extension, entry);
            }
        }

        const index = {
            byLowerName,
            byExtension,
            builtForRoot: key,
        };
        this.resolverCache.set(key, index);
        return index;
    }

    private async findWorkspaceIniDocument(originUri: vscode.Uri, prefix: string) {
        const prefixLower = prefix.toLowerCase();
        for (const document of this.services.iniManager.documents.values()) {
            const uri = document.uri;
            const name = path.posix.basename(uri.path).toLowerCase();
            if (!name.startsWith(prefixLower) || !name.endsWith('.ini')) {
                continue;
            }

            if (uri.scheme === originUri.scheme) {
                if (uri.scheme === MixUriCodec.scheme) {
                    const left = MixUriCodec.decode(uri);
                    const right = MixUriCodec.decode(originUri);
                    if (left.containerUri.toString() !== right.containerUri.toString()) {
                        continue;
                    }
                    if (left.nestedChain.join(':').toLowerCase() !== right.nestedChain.join(':').toLowerCase()) {
                        continue;
                    }
                } else {
                    const folder = vscode.workspace.getWorkspaceFolder(uri);
                    const originFolder = vscode.workspace.getWorkspaceFolder(originUri);
                    if (folder?.uri.toString() !== originFolder?.uri.toString()) {
                        continue;
                    }
                }
            }

            return document;
        }
        return undefined;
    }

    private getSearchRoot(uri: vscode.Uri): vscode.Uri {
        if (uri.scheme === MixUriCodec.scheme) {
            const decoded = MixUriCodec.decode(uri);
            return MixUriCodec.toRootUri(decoded.containerUri, decoded.nestedChain);
        }

        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder?.uri ?? parentDirectoryUri(uri);
    }
}

function pushIndexed(map: Map<string, ResourceEntry[]>, key: string, entry: ResourceEntry): void {
    const existing = map.get(key);
    if (existing) {
        existing.push(entry);
        return;
    }
    map.set(key, [entry]);
}

function prioritizeEntries(entries: ResourceEntry[], relativeTo: vscode.Uri): ResourceEntry[] {
    const currentParent = parentDirectoryUri(relativeTo).toString();
    const currentContainer = getContainerKey(relativeTo);
    return [...entries].sort((left, right) => {
        const leftLocal = sameParent(left.uri, relativeTo) ? 0 : 1;
        const rightLocal = sameParent(right.uri, relativeTo) ? 0 : 1;
        if (leftLocal !== rightLocal) {
            return leftLocal - rightLocal;
        }

        const leftContainer = left.containerKey === currentContainer ? 0 : 1;
        const rightContainer = right.containerKey === currentContainer ? 0 : 1;
        if (leftContainer !== rightContainer) {
            return leftContainer - rightContainer;
        }

        const leftPath = left.uri.path.startsWith(currentParent) ? 0 : 1;
        const rightPath = right.uri.path.startsWith(currentParent) ? 0 : 1;
        if (leftPath !== rightPath) {
            return leftPath - rightPath;
        }

        return left.uri.path.localeCompare(right.uri.path);
    });
}

function sameParent(left: vscode.Uri, right: vscode.Uri): boolean {
    return parentDirectoryUri(left).toString() === parentDirectoryUri(right).toString();
}

function getContainerKey(uri: vscode.Uri): string {
    if (uri.scheme !== MixUriCodec.scheme) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder?.uri.toString() ?? uri.scheme;
    }

    const decoded = MixUriCodec.decode(uri);
    return `${decoded.containerUri.toString()}::${decoded.nestedChain.join(':')}`;
}

function describeUri(target: vscode.Uri, relativeTo: vscode.Uri): string {
    if (target.scheme === MixUriCodec.scheme) {
        const decoded = MixUriCodec.decode(target);
        const containerName = path.basename(decoded.containerUri.path);
        const chain = decoded.nestedChain.join(':');
        const rootName = chain ? `${containerName}:${chain}` : containerName;
        return `${rootName}${decoded.virtualPath}`;
    }

    const folder = vscode.workspace.getWorkspaceFolder(relativeTo);
    if (folder && target.toString().startsWith(folder.uri.toString())) {
        return target.path.slice(folder.uri.path.length) || '/';
    }
    return target.fsPath || target.path;
}

function getValueIgnoreCase(properties: Map<string, string>, key: string): string | undefined {
    for (const [entryKey, value] of properties) {
        if (entryKey.toLowerCase() === key.toLowerCase()) {
            return value;
        }
    }
    return undefined;
}

function hasKeyIgnoreCase(properties: Map<string, string>, key: string): boolean {
    return getValueIgnoreCase(properties, key) !== undefined;
}

function findOwnerSectionByImage(document: import('../parser').IniDocument, shpBaseName: string): string | undefined {
    for (const section of document.sections) {
        const imageValue = getValueIgnoreCase(section.properties, 'Image');
        if (imageValue && imageValue.toLowerCase() === shpBaseName.toLowerCase()) {
            return section.name;
        }
    }
    return undefined;
}

function isAnimationSection(document: import('../parser').IniDocument, ownerSectionName: string): boolean {
    const animations = document.getSection('Animations');
    if (!animations) {
        return false;
    }

    for (const value of animations.properties.values()) {
        if (value.toLowerCase() === ownerSectionName.toLowerCase()) {
            return true;
        }
    }
    return false;
}

function ensurePalExtension(value: string): string {
    return value.toLowerCase().endsWith('.pal') ? value : `${value}.pal`;
}

function parentDirectoryUri(uri: vscode.Uri): vscode.Uri {
    const currentPath = uri.path;
    const index = currentPath.lastIndexOf('/');
    const parentPath = index <= 0 ? '/' : currentPath.slice(0, index);
    return uri.with({ path: parentPath });
}

function basenameWithoutExtension(uri: vscode.Uri): string {
    return path.posix.basename(uri.path, path.posix.extname(uri.path));
}

export function decodeIniBytes(bytes: Uint8Array): string {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(bytes.slice(3));
    }

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return decodeLocalText(bytes);
    }
}
