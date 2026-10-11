import * as vscode from 'vscode';
import { IniDocument } from '../parser';
import { localize } from '../i18n';
import { parsePropertyLine } from './ini-position';

export interface PropertyEditTarget {
    uri: vscode.Uri;
    version: number;
    section: string;
    sectionLine: number;
    key: string;
    valueType?: string;
    minimum?: number;
    maximum?: number;
    allowedValues?: string[];
    caseSensitive?: boolean;
}
export interface PropertyChange {
    target: PropertyEditTarget;
    value: string | null;
}

/** Prepare the complete text transaction before writing any document. */
export async function preparePropertyChanges(changes: PropertyChange[]): Promise<vscode.WorkspaceEdit> {
    if (!changes.length || changes.length > 1000) {
        throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
    }
    const edit = new vscode.WorkspaceEdit();
    const seen = new Set<string>();
    const documents = new Map<string, vscode.TextDocument>();
    const insertions = new Map<
        string,
        { uri: vscode.Uri; position: vscode.Position; keys: string[]; prefix: string; eol: string }
    >();
    for (const { target, value } of changes) {
        if (
            !['file', 'vscode-remote', 'untitled'].includes(target.uri.scheme) ||
            !target.key ||
            /[\r\n\0=;\[\]]/.test(target.key) ||
            (value !== null && (typeof value !== 'string' || /[\r\n\0;]/.test(value)))
        ) {
            throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
        }
        const identity = target.uri.toString() + ':' + target.sectionLine + ':' + target.key.toLowerCase();
        if (seen.has(identity)) {
            throw new Error(
                localize('workbench.duplicateEdit', 'The change plan contains conflicting edits for the same property.')
            );
        }
        seen.add(identity);
        let document = documents.get(target.uri.toString());
        if (!document) {
            document = await vscode.workspace.openTextDocument(target.uri);
            documents.set(target.uri.toString(), document);
        }
        if (document.version !== target.version) {
            throw new Error(
                localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
            );
        }
        const parsed = new IniDocument(document.uri, document.getText());
        const section = parsed.getSectionAt(target.sectionLine);
        if (
            !section ||
            section.startLine !== target.sectionLine ||
            section.name.toLowerCase() !== target.section.toLowerCase()
        ) {
            throw new Error(localize('workbench.missingSection', 'The target section no longer exists.'));
        }
        if (value !== null) {
            if (
                target.allowedValues?.length &&
                !target.allowedValues.some((option) =>
                    target.caseSensitive ? option === value.trim() : option.toLowerCase() === value.trim().toLowerCase()
                )
            ) {
                throw new Error(
                    localize(
                        'workbench.invalidPropertyValue',
                        'The value does not satisfy the property type or range: {0}',
                        target.key
                    )
                );
            }
            const type = target.valueType?.toLowerCase();
            const numeric =
                ['int', 'integer', 'float', 'double', 'number'].includes(type ?? '') ||
                target.minimum !== undefined ||
                target.maximum !== undefined;
            const number = Number(value.trim());
            if (
                ((type === 'bool' || type === 'boolean') && !/^(yes|no|true|false|1|0)$/i.test(value.trim())) ||
                (numeric &&
                    (!value.trim() ||
                        !Number.isFinite(number) ||
                        (['int', 'integer'].includes(type ?? '') && !Number.isInteger(number)) ||
                        (target.minimum !== undefined && number < target.minimum) ||
                        (target.maximum !== undefined && number > target.maximum)))
            ) {
                throw new Error(
                    localize(
                        'workbench.invalidPropertyValue',
                        'The value does not satisfy the property type or range: {0}',
                        target.key
                    )
                );
            }
        }
        const matches: { line: number; start: number; end: number }[] = [];
        for (let line = section.startLine + 1; line <= section.endLine; line++) {
            const property = parsePropertyLine(parsed.lines[line]);
            if (property?.key.toLowerCase() === target.key.toLowerCase()) {
                matches.push({ line, start: property.valueStart, end: property.valueEnd });
            }
        }
        if (value === null) {
            // Remove all local declarations so an earlier duplicate cannot become effective.
            for (const match of matches) {
                const line = document.lineAt(match.line);
                const comment = line.text.indexOf(';', match.end);
                if (comment >= 0) {
                    edit.replace(document.uri, line.range, line.text.match(/^\s*/)?.[0] + line.text.slice(comment));
                } else {
                    edit.delete(document.uri, line.rangeIncludingLineBreak);
                }
            }
        } else if (matches.length) {
            const match = matches[matches.length - 1];
            const raw = document.lineAt(match.line).text.slice(match.start, match.end);
            const leading = raw.length - raw.trimStart().length;
            const end = match.start + (raw.trim() ? raw.trimEnd().length : leading);
            edit.replace(
                document.uri,
                new vscode.Range(match.line, match.start + leading, match.line, end),
                value.trim()
            );
        } else {
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const last = document.lineAt(section.endLine);
            const position =
                section.endLine < document.lineCount - 1 ? new vscode.Position(section.endLine + 1, 0) : last.range.end;
            const id = document.uri.toString() + ':' + position.line + ':' + position.character;
            const insertion = insertions.get(id) ?? {
                uri: document.uri,
                position,
                keys: [],
                eol,
                prefix: position.character ? eol : '',
            };
            insertion.keys.push(target.key + '=' + value.trim());
            insertions.set(id, insertion);
        }
    }
    for (const insertion of insertions.values()) {
        edit.insert(
            insertion.uri,
            insertion.position,
            insertion.prefix + insertion.keys.join(insertion.eol) + insertion.eol
        );
    }
    // A later asynchronous file read must not invalidate an earlier document silently.
    if (changes.some(({ target }) => documents.get(target.uri.toString())?.version !== target.version)) {
        throw new Error(
            localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
        );
    }
    return edit;
}

/** Apply a validated group through VS Code's native multi-document undo stack. */
export async function applyPropertyChanges(changes: PropertyChange[], isCurrent?: () => boolean): Promise<void> {
    const edit = await preparePropertyChanges(changes);
    if (isCurrent && !isCurrent()) {
        throw new Error(
            localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
        );
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error(
            localize('workbench.editFailed', 'VS Code could not apply the change plan. No save was requested.')
        );
    }
}
