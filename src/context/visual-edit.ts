import * as vscode from 'vscode';
import { IniDocument } from '../parser';
import { EditCapability } from './inspection-service';
import { parsePropertyLine } from './ini-position';
import { localize } from '../i18n';

/** Commit a visual gesture as one native text edit, after validating its snapshot. */
export async function applyVisualEdit(target: EditCapability, values: unknown): Promise<void> {
    const deleting =
        values === null &&
        target.kind === 'pixel' &&
        /^DamageFireOffset[0-7]$/i.test(target.key) &&
        target.original !== undefined;
    if (deleting) {
        values = [0, 0];
    }
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
    }
    const dimensions = target.kind === 'pixel' ? 2 : 3;
    const numbers = (values as number[]).slice(0, dimensions);
    if (
        values.length !== dimensions &&
        !(target.kind === 'light' && target.linked && values.length === 4 && [0, 1].includes(values[3]))
    ) {
        throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
    }
    if (target.kind === 'sequence') {
        if (
            numbers.length !== 3 ||
            numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 65535) ||
            numbers[1] < 1
        ) {
            throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
        }
    } else if (
        numbers.length !== dimensions ||
        numbers.some((value) => Math.abs(value) > 1000000) ||
        (['point', 'pixel'].includes(target.kind) && numbers.some((value) => !Number.isInteger(value))) ||
        (target.kind === 'light' && Math.hypot(...numbers) < 0.000001)
    ) {
        throw new Error(localize('workbench.invalidEdit', 'Invalid visual edit.'));
    }
    const document = await vscode.workspace.openTextDocument(target.uri);
    if (document.version !== target.version) {
        throw new Error(
            localize('workbench.staleEdit', 'The document changed. Refresh the preview before applying this edit.')
        );
    }
    const parsed = new IniDocument(document.uri, document.getText());
    const section = parsed.getSection(target.section);
    if (!section) {
        throw new Error(localize('workbench.missingSection', 'The target section no longer exists.'));
    }
    const edit = new vscode.WorkspaceEdit();
    let value = numbers.join(',');
    if (target.kind === 'sequence' && target.original) {
        const suffix = target.original.split(',').slice(3);
        if (suffix.length) {
            value += ',' + suffix.join(',');
        }
    }
    const replacements = [{ key: target.key, original: target.original, value }];
    if (target.linked && values.length === 4) {
        replacements.push({
            key: target.linked.key,
            original: target.linked.original,
            value: values[3] ? 'yes' : 'no',
        });
    }
    const missing: string[] = [];
    for (const replacement of replacements) {
        let matching: { line: number; property: NonNullable<ReturnType<typeof parsePropertyLine>> } | undefined;
        for (let line = section.startLine + 1; line <= section.endLine; line++) {
            const property = parsePropertyLine(document.lineAt(line).text);
            if (property?.key.toLowerCase() === replacement.key.toLowerCase()) {
                matching = { line, property };
            }
        }
        if (matching) {
            if (replacement.original === undefined || matching.property.value !== replacement.original) {
                throw new Error(
                    localize(
                        'workbench.staleEdit',
                        'The document changed. Refresh the preview before applying this edit.'
                    )
                );
            }
            const line = document.lineAt(matching.line).text;
            if (deleting) {
                edit.delete(document.uri, document.lineAt(matching.line).rangeIncludingLineBreak);
                continue;
            }
            const raw = line.slice(matching.property.valueStart, matching.property.valueEnd);
            const leading = raw.length - raw.trimStart().length;
            const trailing = raw.trim().length ? raw.length - raw.trimEnd().length : 0;
            edit.replace(
                document.uri,
                new vscode.Range(
                    matching.line,
                    matching.property.valueStart + leading,
                    matching.line,
                    matching.property.valueEnd - trailing
                ),
                replacement.value
            );
        } else {
            missing.push(replacement.key + '=' + replacement.value);
        }
    }
    if (missing.length) {
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
            next = section.endLine + 1;
        if (next < document.lineCount) {
            edit.insert(document.uri, new vscode.Position(next, 0), missing.join(eol) + eol);
        } else {
            const end = document.lineAt(document.lineCount - 1).range.end;
            edit.insert(document.uri, end, (end.character ? eol : '') + missing.join(eol) + eol);
        }
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error(localize('workbench.editFailed', 'The editor could not apply this change.'));
    }
}
