import * as vscode from 'vscode';
import { ConfigurationService } from './configuration-service';
import { ConfigurationChange, ConfigurationScope } from './configuration-model';

interface ConfigurationHost {
    service: ConfigurationService;
    origin: vscode.Uri;
    root: vscode.Uri;
    scope?: ConfigurationScope;
    groups: string[];
    setScope: (scope: ConfigurationScope) => void;
    post: (message: object) => void;
    refresh: () => void;
    editing: (active: boolean) => void;
}

/** Both product pages use the same validated configuration capabilities. */
export async function configurationMessage(host: ConfigurationHost, message: unknown): Promise<boolean> {
    const data = message as {
        type?: string;
        snapshot?: string;
        key?: string;
        parts?: string[];
        changes?: ConfigurationChange[];
        value?: string;
        active?: boolean;
    };
    if (!data.type?.startsWith('configuration-')) {
        return false;
    }
    if (data.type === 'configuration-scope' && ['user', 'workspace', 'folder'].includes(data.value ?? '')) {
        host.service.pin();
        host.setScope(host.service.describe(host.origin, host.groups, data.value as ConfigurationScope).scope);
        host.refresh();
    } else if (data.type === 'configuration-draft') {
        host.service.pin(data.active ? data.snapshot : undefined);
        host.editing(data.active === true);
        if (!data.active) {
            host.refresh();
        }
    } else if (
        data.type === 'configuration-pick' &&
        typeof data.snapshot === 'string' &&
        typeof data.key === 'string'
    ) {
        try {
            const values = await host.service.pick(data.snapshot, data.key, data.parts ?? [], host.root);
            host.post({
                type: 'configuration-picked',
                snapshot: data.snapshot,
                key: data.key,
                parts: data.parts ?? [],
                values: values ?? [],
            });
        } catch (error) {
            console.error('[Configuration] File selection failed', error);
            host.post({
                type: 'configuration-picked',
                snapshot: data.snapshot,
                key: data.key,
                parts: data.parts ?? [],
                values: [],
                error: error instanceof Error ? error.message : String(error),
            });
        }
    } else if (data.type === 'configuration-check-paths' && typeof data.snapshot === 'string') {
        const checks = await host.service.checkPaths(data.snapshot, host.root);
        host.post({ type: 'configuration-paths', snapshot: data.snapshot, checks });
    } else if (data.type === 'configuration-apply' && typeof data.snapshot === 'string') {
        try {
            await host.service.apply(data.snapshot, data.changes!);
            if (data.changes?.some((change) => change.key === 'schemaFilePath')) {
                await vscode.commands.executeCommand('ra2-ini-intellisense.reloadDictionary', host.origin);
            }
            host.service.pin();
            host.editing(false);
            host.post({
                type: 'configuration-result',
                snapshot: data.snapshot,
                ok: true,
                configuration: host.service.describe(host.origin, host.groups, host.scope),
            });
            host.refresh();
        } catch (error) {
            console.error('[Configuration] Apply failed', error);
            host.post({
                type: 'configuration-result',
                snapshot: data.snapshot,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return true;
}
