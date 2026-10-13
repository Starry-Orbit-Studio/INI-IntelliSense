import * as vscode from 'vscode';
import { localize } from '../i18n';
import { compileFileCategoryGlob } from '../file-type-manager';

export const SEVERITIES = ['Error', 'Warning', 'Information', 'Hint', 'None'] as const;
export type RuleSeverity = (typeof SEVERITIES)[number];
const definitions: [string, string, RuleSeverity][] = [
    ['S001', 'Leading whitespace', 'Warning'],
    ['S002', 'Spaces before equals', 'Warning'],
    ['S003', 'Spaces after equals', 'Warning'],
    ['S004', 'Spaces before comments', 'Warning'],
    ['S005', 'Space after comment marker', 'Warning'],
    ['T001', 'Invalid integer', 'Error'],
    ['T002', 'Invalid floating-point value', 'Error'],
    ['T003', 'Number outside allowed range', 'Error'],
    ['T004', 'Value outside allowed enumeration', 'Error'],
    ['T005', 'Invalid value prefix', 'Error'],
    ['T006', 'Invalid value suffix', 'Error'],
    ['T007', 'Invalid list length', 'Error'],
    ['T008', 'Invalid boolean', 'Error'],
    ['T009', 'Referenced object has an incompatible type', 'Warning'],
    ['T010', 'Empty list member', 'Warning'],
    ['C001', 'Included file could not be loaded', 'Warning'],
    ['C002', 'Include cycle', 'Warning'],
    ['C003', 'Missing parent section', 'Warning'],
    ['C004', 'Inheritance cycle', 'Error'],
    ['L001', 'Missing referenced section', 'Error'],
    ['L003', 'Empty value', 'Hint'],
    ['L004', 'Duplicate registry key', 'Information'],
    ['L005', 'Unknown key for the inferred type', 'None'],
    ['L006', 'Repeated key within a section', 'Information'],
    ['L007', 'Numbered key outside its effective range', 'Warning'],
    ['L008', 'Key belongs to a different file purpose', 'Information'],
    ['L009', 'Repeated registered object', 'Information'],
    ['L010', 'Registered object has no definition', 'Warning'],
];
export function ruleCatalog() {
    return definitions.map(([id, name, severity]) => ({
        id,
        name: localize('checks.rule.' + id, name),
        severity,
        group: id[0],
    }));
}
export function isSeverity(value: unknown): value is RuleSeverity {
    return typeof value === 'string' && SEVERITIES.includes(value as RuleSeverity);
}
/** Explain the winning setting without exposing compatibility switches as duplicate controls. */
export function ruleSource(uri: vscode.Uri, id: string): string {
    const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics', uri);
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const overrides = configuration.get<{ files: string; severity: Record<string, string> }[]>('overrides', []);
    if (overrides.some(override => typeof override.files === 'string' && compileFileCategoryGlob(override.files).test(relative) && override.severity?.[id] !== undefined)) { return 'exception'; }
    const severity = configuration.inspect<Record<string, string>>('severity');
    for (const [scope, values] of [['folder', severity?.workspaceFolderValue], ['workspace', severity?.workspaceValue], ['user', severity?.globalValue]] as const) { if (values?.[id] !== undefined) { return scope; } }
    const switches: Record<string, string> = { S001: 'leadingWhitespace', S002: 'spaceBeforeEquals', S003: 'spaceAfterEquals', S005: 'spaceAfterComment' };
    const key = switches[id];
    if (key) {
        const details = configuration.inspect(key);
        if (details?.workspaceFolderValue !== undefined) { return 'folder'; }
        if (details?.workspaceValue !== undefined) { return 'workspace'; }
        if (details?.globalValue !== undefined) { return 'user'; }
    }
    return 'default';
}

/** Explicit severities supersede legacy switches; policies are resource-scoped. */
export function rulePolicy(uri: vscode.Uri): Map<string, vscode.DiagnosticSeverity | null> {
    const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics', uri);
    const raw = configuration.get<Record<string, string>>('severity', {});
    const legacy: Record<string, string> = {
        S001: 'leadingWhitespace',
        S002: 'spaceBeforeEquals',
        S003: 'spaceAfterEquals',
        S005: 'spaceAfterComment',
    };
    const disabled = configuration.get<string[]>('disable', []),
        names = ['error', 'warning', 'information', 'hint'];
    const result = new Map<string, vscode.DiagnosticSeverity | null>();
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    for (const rule of ruleCatalog()) {
        let value =
            raw[rule.id] ??
            (disabled.includes(rule.id) || (legacy[rule.id] && configuration.get(legacy[rule.id]) === false)
                ? 'None'
                : rule.severity);
        for (const override of configuration.get<{ files: string; severity: Record<string, string> }[]>(
            'overrides',
            []
        )) {
            if (
                typeof override.files === 'string' &&
                compileFileCategoryGlob(override.files).test(relative) &&
                override.severity?.[rule.id] !== undefined
            ) {
                value = override.severity[rule.id];
            }
        }
        const index = typeof value === 'string' ? names.indexOf(value.toLowerCase()) : -1;
        const fallback = names.indexOf(rule.severity.toLowerCase());
        result.set(
            rule.id,
            index >= 0 ? index : String(value).toLowerCase() === 'none' ? null : fallback < 0 ? null : fallback
        );
    }
    return result;
}
