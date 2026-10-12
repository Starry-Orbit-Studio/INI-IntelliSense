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
    ['L001', 'Missing referenced section', 'Error'],
    ['L003', 'Empty value', 'Warning'],
    ['L004', 'Duplicate registry key', 'Error'],
    ['L005', 'Unknown key for the inferred type', 'None'],
    ['L006', 'Repeated key within a section', 'Information'],
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
    const relative = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
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
