import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { isWithinRoot } from '../resources/project-root';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';
import { ruleCatalog } from '../diagnostics/rule-catalog';
import { localize } from '../i18n';
import {
    ConfigurationChange,
    ConfigurationModel,
    ConfigurationScope,
    CONFIGURATION_FIELDS,
} from './configuration-model';

interface Definition {
    type?: string | string[];
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    minLength?: number;
    required?: string[];
    properties?: Record<string, Definition>;
    additionalProperties?: Definition | boolean;
    items?: Definition;
}
interface Snapshot {
    origin: vscode.Uri;
    model: ConfigurationModel;
    values: Map<string, { selected: unknown; effective: unknown }>;
}
const target = (scope: ConfigurationScope) =>
    scope === 'user'
        ? vscode.ConfigurationTarget.Global
        : scope === 'workspace'
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.WorkspaceFolder;
const selected = (details: ReturnType<vscode.WorkspaceConfiguration['inspect']>, scope: ConfigurationScope) =>
    scope === 'user'
        ? details?.globalValue
        : scope === 'workspace'
          ? details?.workspaceValue
          : details?.workspaceFolderValue;
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item
    ) ?? 'undefined';

/** Resolve only the selected layer and its parents, keeping higher overrides visible separately. */
export function configurationLayer(
    details:
        | { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
        | undefined,
    scope: ConfigurationScope
): unknown {
    const merge = (base: unknown, next: unknown): unknown => {
        if (next === undefined) {
            return base;
        }
        if (
            base &&
            next &&
            typeof base === 'object' &&
            typeof next === 'object' &&
            !Array.isArray(base) &&
            !Array.isArray(next)
        ) {
            const result = { ...base } as Record<string, unknown>;
            for (const [key, value] of Object.entries(next)) {
                Object.defineProperty(result, key, {
                    value: merge(result[key], value),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return result;
        }
        return next;
    };
    let result = merge(details?.defaultValue, details?.globalValue);
    if (scope !== 'user') {
        result = merge(result, details?.workspaceValue);
    }
    if (scope === 'folder') {
        result = merge(result, details?.workspaceFolderValue);
    }
    return result ?? null;
}

/** Validate nested contributions before any configuration writes occur. */
export function validConfiguration(value: unknown, schema: Definition, depth = 0): boolean {
    if (depth > 10) {
        return false;
    }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (
        schema.type &&
        ![schema.type].flat().includes(type) &&
        !([schema.type].flat().includes('integer') && Number.isInteger(value))
    ) {
        return false;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return false;
    }
    if (
        typeof value === 'number' &&
        (!Number.isFinite(value) ||
            (schema.minimum !== undefined && value < schema.minimum) ||
            (schema.maximum !== undefined && value > schema.maximum))
    ) {
        return false;
    }
    if (typeof value === 'string' && (value.length > 16384 || value.length < (schema.minLength ?? 0))) {
        return false;
    }
    if (Array.isArray(value)) {
        return (
            value.length <= Math.min(schema.maxItems ?? 1000, 1000) &&
            (!schema.items || value.every((item) => validConfiguration(item, schema.items!, depth + 1)))
        );
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > 1000 || schema.required?.some((key) => !Object.hasOwn(value, key))) {
            return false;
        }
        return entries.every(([key, item]) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key) || !key.trim() || key.length > 512) {
                return false;
            }
            const child = schema.properties?.[key];
            if (child) {
                return validConfiguration(item, child, depth + 1);
            }
            return (
                schema.additionalProperties !== false &&
                (typeof schema.additionalProperties !== 'object' ||
                    validConfiguration(item, schema.additionalProperties, depth + 1))
            );
        });
    }
    return true;
}

/** Per-page capability snapshots serialize writes and protect drafts against external edits. */
export class ConfigurationService {
    private readonly definitions: Record<string, Definition>;
    private readonly snapshots = new Map<string, Snapshot>();
    private queue: Promise<unknown> = Promise.resolve();
    private pinned?: string;
    constructor(extension: vscode.Uri) {
        this.definitions = JSON.parse(
            fs.readFileSync(vscode.Uri.joinPath(extension, 'package.json').fsPath, 'utf8')
        ).contributes.configuration.properties;
    }
    public describe(origin: vscode.Uri, groups: string[], scope?: ConfigurationScope): ConfigurationModel {
        const folder = vscode.workspace.getWorkspaceFolder(origin);
        const writableFolder = folder && ['file', 'vscode-remote'].includes(folder.uri.scheme);
        const workspaceSettings = vscode.workspace.workspaceFile || writableFolder;
        const scopes: ConfigurationScope[] = [
            'user',
            ...(workspaceSettings ? ['workspace' as const] : []),
            ...(writableFolder ? ['folder' as const] : []),
        ];
        scope = scope && scopes.includes(scope) ? scope : writableFolder ? 'folder' : 'user';
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', origin);
        const values = new Map<string, { selected: unknown; effective: unknown }>();
        const fields = CONFIGURATION_FIELDS.filter((field) => groups.includes(field.group)).map((field) => {
            const details = configuration.inspect(field.key),
                value = configuration.get(field.key) ?? null;
            const raw = selected(details, scope!);
            values.set(field.key, { selected: raw, effective: value });
            const source: ConfigurationScope | 'default' =
                details?.workspaceFolderValue !== undefined
                    ? 'folder'
                    : details?.workspaceValue !== undefined
                      ? 'workspace'
                      : details?.globalValue !== undefined
                        ? 'user'
                        : 'default';
            return {
                ...field,
                choices: field.control === 'exceptions' ? ruleCatalog().map((rule) => rule.id) : field.choices,
                value: configurationLayer(details, scope!),
                effective: value,
                configured: raw !== undefined,
                source,
            };
        });
        const model: ConfigurationModel = {
            id: randomUUID(),
            origin: (folder?.uri ?? origin).toString(),
            scope,
            scopes,
            fields,
            destination:
                scope === 'folder'
                    ? vscode.Uri.joinPath(folder!.uri, '.vscode/settings.json').fsPath
                    : scope === 'workspace'
                      ? (vscode.workspace.workspaceFile?.fsPath ??
                        (vscode.workspace.workspaceFolders?.[0]
                            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode/settings.json')
                                  .fsPath
                            : localize('config.workspaceDestination', 'Workspace settings')))
                      : localize('config.userDestination', 'VS Code user settings'),
        };
        this.snapshots.set(model.id, { origin, model, values });
        while (this.snapshots.size > 24) {
            this.snapshots.delete([...this.snapshots.keys()].find((id) => id !== this.pinned)!);
        }
        return model;
    }
    public pin(id?: string): void {
        this.pinned = id && this.snapshots.has(id) ? id : undefined;
    }
    public async checkPaths(id: string, root: vscode.Uri): Promise<{ key: string; path: string; state: string }[]> {
        const snapshot = this.snapshots.get(id);
        if (!snapshot) {
            return [];
        }
        const paths: { key: string; value: string }[] = [];
        for (const field of snapshot.model.fields) {
            if (field.control === 'path') {
                paths.push({ key: field.key, value: String(field.value ?? '') });
            }
            if (field.control === 'renderer') {
                for (const key of ['executable', 'mixDirectory']) {
                    paths.push({ key, value: String((field.value as Record<string, unknown>)?.[key] ?? '') });
                }
            }
            if (field.control === 'list' && field.picker === 'directory' && Array.isArray(field.value)) {
                field.value.forEach((value) => paths.push({ key: field.key, value: String(value) }));
            }
        }
        return Promise.all(
            paths.slice(0, 64).map(async (item) => {
                if (!item.value) {
                    return { key: item.key, path: '', state: 'unconfigured' };
                }
                const resolved = path.resolve(root.fsPath, item.value);
                try {
                    let timer: NodeJS.Timeout | undefined;
                    let stat: vscode.FileStat;
                    try {
                        stat = await Promise.race([
                            vscode.workspace.fs.stat(vscode.Uri.file(resolved)),
                            new Promise<never>((_resolve, reject) => {
                                timer = setTimeout(() => reject(new Error('Path check timed out')), 2500);
                            }),
                        ]);
                    } finally {
                        clearTimeout(timer);
                    }
                    const field = CONFIGURATION_FIELDS.find((field) => field.key === item.key);
                    const directory = field?.picker === 'directory' || item.key === 'mixDirectory';
                    return {
                        key: item.key,
                        path: resolved,
                        state: directory
                            ? Boolean(stat.type & vscode.FileType.Directory)
                                ? 'ready'
                                : 'wrongType'
                            : Boolean(stat.type & vscode.FileType.File)
                              ? 'ready'
                              : 'wrongType',
                    };
                } catch {
                    return { key: item.key, path: resolved, state: 'missing' };
                }
            })
        );
    }
    public apply(id: string, changes: ConfigurationChange[]): Promise<void> {
        const pending = this.queue.then(() => this.write(id, changes));
        this.queue = pending.catch(() => undefined);
        return pending;
    }
    private async write(id: string, changes: ConfigurationChange[]): Promise<void> {
        const snapshot = this.snapshots.get(id);
        if (!snapshot || !Array.isArray(changes) || !changes.length || changes.length > 40) {
            throw new Error(localize('config.expired', 'Refresh this page before applying configuration.'));
        }
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', snapshot.origin),
            keys = new Set<string>();
        for (const change of changes) {
            if (
                !change ||
                typeof change.key !== 'string' ||
                keys.has(change.key) ||
                !snapshot.values.has(change.key) ||
                (change.reset !== undefined && typeof change.reset !== 'boolean')
            ) {
                throw new Error(localize('config.invalid', 'Invalid configuration change.'));
            }
            keys.add(change.key);
            const previous = snapshot.values.get(change.key)!;
            if (
                canonical(previous.selected) !==
                    canonical(selected(configuration.inspect(change.key), snapshot.model.scope)) ||
                canonical(previous.effective) !== canonical(configuration.get(change.key) ?? null)
            ) {
                throw new Error(
                    localize(
                        'config.conflict',
                        'Settings changed outside this page. Discard or refresh your draft before applying.'
                    )
                );
            }
            if (
                change.key === 'validationFolderPath' &&
                !change.reset &&
                typeof change.value === 'string' &&
                change.value
            ) {
                const physical =
                    snapshot.origin.scheme === MixUriCodec.scheme
                        ? MixUriCodec.decode(snapshot.origin).containerUri
                        : snapshot.origin;
                const base = vscode.workspace.getWorkspaceFolder(physical)?.uri.fsPath ?? path.dirname(physical.fsPath);
                const root = /^[a-z][\w+.-]*:\/\//i.test(change.value)
                    ? vscode.Uri.parse(change.value)
                    : vscode.Uri.file(path.resolve(base, change.value));
                if (!isWithinRoot(root, physical)) {
                    throw new Error(
                        localize(
                            'config.unrelatedRoot',
                            'The mod root must contain this project or its entry files. Add unrelated asset directories under Resource sources.'
                        )
                    );
                }
                change.value = root.fsPath;
            }
            if (
                !change.reset &&
                !validConfiguration(change.value, this.definitions['ra2-ini-intellisense.' + change.key])
            ) {
                throw new Error(localize('config.invalidField', 'Invalid value for {0}.', change.key));
            }
        }
        const written: ConfigurationChange[] = [];
        try {
            for (const change of changes) {
                await this.writeValue(
                    configuration,
                    change.key,
                    change.reset ? undefined : change.value,
                    target(snapshot.model.scope)
                );
                written.push(change);
            }
        } catch (error) {
            // Roll back only our still-current writes; never erase a concurrent user's edit.
            let rollbackFailed = false;
            for (const change of written.reverse()) {
                const current = selected(configuration.inspect(change.key), snapshot.model.scope);
                if (canonical(current) === canonical(change.reset ? undefined : change.value)) {
                    try {
                        await this.writeValue(
                            configuration,
                            change.key,
                            snapshot.values.get(change.key)!.selected,
                            target(snapshot.model.scope)
                        );
                    } catch (rollback) {
                        rollbackFailed = true;
                        console.error('[Configuration] Rollback failed', rollback);
                    }
                }
            }
            if (rollbackFailed) {
                throw new Error(
                    localize(
                        'config.partialFailure',
                        'Some saved values could not be restored. Refresh to inspect the current settings.'
                    ),
                    { cause: error }
                );
            }
            throw error;
        }
    }
    protected async writeValue(
        configuration: vscode.WorkspaceConfiguration,
        key: string,
        value: unknown,
        scope: vscode.ConfigurationTarget
    ): Promise<void> {
        await configuration.update(key, value, scope);
    }
    public async pick(id: string, key: string, parts: string[], root: vscode.Uri): Promise<string[] | undefined> {
        const snapshot = this.snapshots.get(id),
            field = snapshot?.model.fields.find((field) => field.key === key);
        if (
            !field ||
            !Array.isArray(parts) ||
            parts.length > 2 ||
            parts.some((part) => typeof part !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(part))
        ) {
            return undefined;
        }
        let kind = field.picker;
        if (field.control === 'renderer') {
            const permitted: Record<string, 'file' | 'directory' | 'ini' | 'mix'> = {
                executable: 'file',
                mixDirectory: 'directory',
                modDirectories: 'directory',
                rulesFiles: 'ini',
                artFiles: 'ini',
                extraMixes: 'mix',
            };
            kind = permitted[parts[0]];
        }
        if (!kind) {
            return undefined;
        }
        const choices = await vscode.window.showOpenDialog({
            defaultUri: root,
            canSelectFolders: kind === 'directory',
            canSelectFiles: kind !== 'directory',
            canSelectMany:
                field.control === 'list' ||
                field.control === 'entries' ||
                ['modDirectories', 'rulesFiles', 'artFiles', 'extraMixes'].includes(parts[0]),
            filters:
                kind === 'ini' ? { INI: ['ini', 'map', 'mpr', 'yrm'] } : kind === 'mix' ? { MIX: ['mix'] } : undefined,
        });
        return choices?.map((uri) =>
            key === 'media.archiveOrder'
                ? path.posix.basename(uri.path)
                : key === 'project.entryPoints' || key === 'validationFiles'
                  ? uri.path.startsWith(root.path + '/')
                      ? uri.path.slice(root.path.length + 1)
                      : uri.fsPath
                  : key === 'indexing.fileOverrides'
                    ? vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
                    : uri.fsPath
        );
    }
}
