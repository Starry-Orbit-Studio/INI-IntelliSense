import * as path from 'path';
import * as vscode from 'vscode';
import { INIManager } from '../parser';
import { localize } from '../i18n';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { MixWorkspaceManager } from '../mix/fs/mix-workspace-manager';
import { decodeLocalText } from '../mix/core/local-encoding';
import { PaletteColor, createGrayscalePalette, readPalette } from './palette-utils';

interface ResourceEntry {
    uri: vscode.Uri;
    name: string;
    baseName: string;
    extension: string;
}

export interface PaletteSelection {
    uri?: vscode.Uri;
    label: string;
    colors: PaletteColor[];
    source: 'auto' | 'manual' | 'fallback';
}

export interface PreviewContextServices {
    iniManager: INIManager;
    mixWorkspaceManager: MixWorkspaceManager;
}

export class PreviewContext {
    private readonly directoryCache = new Map<string, vscode.Uri[]>();
    private readonly paletteCache = new Map<string, PaletteColor[]>();

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
                        return {
                            uri: resolved,
                            label: path.posix.basename(resolved.path),
                            colors: await this.readPalette(resolved),
                            source: 'auto',
                        };
                    }
                }

                if (hasKeyIgnoreCase(section.properties, 'AltPalette')) {
                    const altPalette = await this.findPaletteByName(uri, 'unittem.pal');
                    if (altPalette) {
                        return {
                            uri: altPalette,
                            label: path.posix.basename(altPalette.path),
                            colors: await this.readPalette(altPalette),
                            source: 'auto',
                        };
                    }
                }

                const paletteValue = getValueIgnoreCase(section.properties, 'Palette');
                if (paletteValue) {
                    const resolved = paletteValue.toLowerCase().endsWith('.pal')
                        ? await this.findPaletteByName(uri, paletteValue)
                        : await this.findPaletteByWildcard(uri, paletteValue);
                    if (resolved) {
                        return {
                            uri: resolved,
                            label: path.posix.basename(resolved.path),
                            colors: await this.readPalette(resolved),
                            source: 'auto',
                        };
                    }
                }
            }
        }

        const rulesDocument = await this.findWorkspaceIniDocument(uri, 'rules');
        if (rulesDocument) {
            const ownerSectionName = findOwnerSectionByImage(rulesDocument, shpBaseName);
            if (ownerSectionName && isAnimationSection(rulesDocument, ownerSectionName)) {
                const animPalette = await this.findPaletteByName(uri, 'anim.pal');
                if (animPalette) {
                    return {
                        uri: animPalette,
                        label: path.posix.basename(animPalette.path),
                        colors: await this.readPalette(animPalette),
                        source: 'auto',
                    };
                }
            }
        }

        const sameNamePalette = await this.findPaletteByName(uri, `${shpBaseName}.pal`);
        if (sameNamePalette) {
            return {
                uri: sameNamePalette,
                label: path.posix.basename(sameNamePalette.path),
                colors: await this.readPalette(sameNamePalette),
                source: 'auto',
            };
        }

        const defaultPalette = await this.findPaletteByName(uri, 'unittem.pal');
        if (defaultPalette) {
            return {
                uri: defaultPalette,
                label: path.posix.basename(defaultPalette.path),
                colors: await this.readPalette(defaultPalette),
                source: 'auto',
            };
        }

        return {
            label: localize('preview.palette.grayscale', 'Grayscale Fallback'),
            colors: createGrayscalePalette(),
            source: 'fallback',
        };
    }

    public async choosePalette(uri: vscode.Uri): Promise<PaletteSelection | undefined> {
        const palettes = await this.findAllPalettes(uri);
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

        return {
            uri: selected.entry.uri,
            label: selected.entry.name,
            colors: await this.readPalette(selected.entry.uri),
            source: 'manual',
        };
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
        const sibling = uri.with({
            path: replaceLeafName(uri.path, siblingName),
        });
        try {
            return await vscode.workspace.fs.readFile(sibling);
        } catch {
            return undefined;
        }
    }

    public clearCaches(): void {
        this.directoryCache.clear();
        this.paletteCache.clear();
    }

    private async findPaletteByWildcard(uri: vscode.Uri, prefix: string): Promise<vscode.Uri | undefined> {
        const palettes = await this.findAllPalettes(uri);
        const loweredPrefix = prefix.toLowerCase();
        const match = palettes.find(entry =>
            entry.name.toLowerCase().startsWith(loweredPrefix)
            && entry.name.toLowerCase().endsWith('.pal')
        );
        return match?.uri;
    }

    private async findPaletteByName(uri: vscode.Uri, name: string): Promise<vscode.Uri | undefined> {
        const exactName = path.posix.basename(name).toLowerCase();
        const currentDirectory = await this.listDirectory(uri);
        const localMatch = currentDirectory.find(entry => path.posix.basename(entry.path).toLowerCase() === exactName);
        if (localMatch) {
            return localMatch;
        }

        const palettes = await this.findAllPalettes(uri);
        const exactMatch = palettes.find(entry => entry.name.toLowerCase() === exactName);
        return exactMatch?.uri;
    }

    private async findAllPalettes(uri: vscode.Uri): Promise<ResourceEntry[]> {
        const root = this.getSearchRoot(uri);
        const entries = await this.walkFiles(root);
        return entries.filter(entry => entry.extension === '.pal');
    }

    private async walkFiles(root: vscode.Uri): Promise<ResourceEntry[]> {
        const results: ResourceEntry[] = [];
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

                results.push({
                    uri: child,
                    name,
                    baseName: basenameWithoutExtension(child),
                    extension: path.extname(name).toLowerCase(),
                });
            }
        }

        return results;
    }

    private async listDirectory(uri: vscode.Uri): Promise<vscode.Uri[]> {
        const parent = parentDirectoryUri(uri);
        const key = parent.toString();
        const cached = this.directoryCache.get(key);
        if (cached) {
            return cached;
        }

        const entries = await vscode.workspace.fs.readDirectory(parent);
        const children = entries
            .filter(([, type]) => type === vscode.FileType.File)
            .map(([name]) => vscode.Uri.joinPath(parent, name));
        this.directoryCache.set(key, children);
        return children;
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
        if (entryKey.localeCompare(key, undefined, { sensitivity: 'accent' }) === 0 || entryKey.toLowerCase() === key.toLowerCase()) {
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

function replaceLeafName(filePath: string, newName: string): string {
    const index = filePath.lastIndexOf('/');
    if (index === -1) {
        return `/${newName}`;
    }
    return `${filePath.slice(0, index + 1)}${newName}`;
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
