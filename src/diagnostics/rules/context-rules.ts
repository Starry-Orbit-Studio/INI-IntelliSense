import * as vscode from 'vscode';
import { IniDocument } from '../../parser';
import { ProjectIni } from '../../context/project-ini';
import { parsePropertyLine } from '../../context/ini-position';
import { SchemaManager } from '../../schema-manager';
import { keyPattern, patternIndex, patternBound } from '../../dictionary/key-pattern';
import { IniDiagnostic } from '../diagnostic';
import { ErrorCode } from '../error-codes';
import { RuleContext, ValidationRule } from '../rules';
import { localize } from '../../i18n';

/** Only conclusions supported by the configured loader and dictionary are reported. */
export function structuralRules(document: vscode.TextDocument, model: IniDocument, project?: ProjectIni): IniDiagnostic[] {
    if (!project || project.context(document.uri).compatibility === 'vanilla') { return []; }
    const result: IniDiagnostic[] = [], snapshot = project.snapshot(document.uri), category = project.category(document.uri);
    const parsedDocuments = new Map(project.documents(document.uri).map(item => [item.uri.toString(), item]));
    const diagnostic = (line: number, code: ErrorCode, message: string, related: vscode.DiagnosticRelatedInformation[] = []) => {
        const item = new IniDiagnostic(document.lineAt(line).range, message, vscode.DiagnosticSeverity.Warning, code);
        item.relatedInformation = related; result.push(item);
    };
    for (const section of model.sections) {
        if (section.name.toLowerCase() === '#include') {
            for (let line = section.startLine + 1; line <= section.endLine; line++) {
                const property = parsePropertyLine(model.lines[line]);
                if (!property?.value) { continue; }
                const target = project.includeTarget(document.uri, document.uri, property.value);
                if (!target || !parsedDocuments.has(target.toString())) {
                    diagnostic(line, ErrorCode.CONTEXT_MISSING_INCLUDE, localize('checks.includeMissing', 'Included file "{0}" could not be loaded. Dependent checks are deferred until the loading context is complete.', property.value));
                    continue;
                }
                const pending: { uri: vscode.Uri; chain: string[] }[] = [{ uri: target, chain: [document.uri.toString()] }];
                const seen = new Set<string>();
                while (pending.length && seen.size < 2000) {
                    const next = pending.pop()!, id = next.uri.toString();
                    if (id === document.uri.toString()) {
                        diagnostic(line, ErrorCode.CONTEXT_INCLUDE_CYCLE, localize('checks.includeCycle', 'Include cycle: {0}. Review the loading order.', [...next.chain, id].map(uri => vscode.Uri.parse(uri).path.split('/').at(-1)).join(' → '))); break;
                    }
                    if (seen.has(id)) { continue; } seen.add(id);
                    const parsed = parsedDocuments.get(id);
                    for (const value of parsed?.getSection('#include')?.properties.values() ?? []) {
                        const child = project.includeTarget(document.uri, next.uri, value);
                        if (child) { pending.push({ uri: child, chain: [...next.chain, id] }); }
                    }
                }
            }
        }
        if (!snapshot.context.complete || !section.parentNames.length) { continue; }
        for (const parent of section.parentNames) {
            if (!snapshot.sources(parent, category).length) {
                diagnostic(section.startLine, ErrorCode.CONTEXT_MISSING_PARENT, localize('checks.parentMissing', 'Parent section [{0}] could not be found in the current {1} loading context.', parent, category)); continue;
            }
            const pending = [{ name: parent, chain: [section.name] }], seen = new Set<string>();
            while (pending.length && seen.size < 2000) {
                const next = pending.pop()!, id = next.name.toLowerCase();
                if (id === section.name.toLowerCase()) {
                    diagnostic(section.startLine, ErrorCode.CONTEXT_INHERITANCE_CYCLE, localize('checks.inheritanceCycle', 'Inheritance cycle: {0}. Values inside the cycle cannot be resolved reliably.', [...next.chain, next.name].join(' → ')), snapshot.sources(parent, category).map(source => new vscode.DiagnosticRelatedInformation(new vscode.Location(source.document.uri, new vscode.Position(source.section.startLine, 0)), localize('checks.parentDeclaration', 'Parent declaration')))); break;
                }
                if (seen.has(id)) { continue; } seen.add(id);
                for (const source of snapshot.sources(next.name, category)) {
                    for (const ancestor of source.section.parentNames) { pending.push({ name: ancestor, chain: [...next.chain, next.name] }); }
                }
            }
        }
    }
    return result;
}

export const checkNumberedKey: ValidationRule = (context: RuleContext) => {
    const property = parsePropertyLine(context.codePart), section = context.currentSection.name;
    if (!property || !section || !context.project || !context.project.context(context.document.uri).complete) { return []; }
    const definition = context.schemaManager.getProperty(context.currentSection.typeName ?? '', property.key);
    const declaration = definition?.declaration, pattern = declaration && keyPattern(declaration);
    if (!pattern) { return []; }
    const index = patternIndex(declaration!, property.key), values = context.project.effective(context.document.uri, section, context.project.category(context.document.uri));
    const read = (key: string) => values.get(key.toLowerCase())?.value ?? context.schemaManager.getProperty(context.currentSection.typeName ?? '', key)?.defaultValue;
    const min = patternBound(pattern.minimum, read), max = patternBound(pattern.maximum, read);
    if (index === undefined || min === undefined || max === undefined || (index >= min && index <= max)) { return []; }
    const diagnostic = new IniDiagnostic(new vscode.Range(context.lineNumber, property.keyStart, context.lineNumber, property.keyEnd),
        localize('checks.numberedRange', 'Index {0} is outside the effective range {1}–{2} defined by {3}.', index, min, max, declaration), vscode.DiagnosticSeverity.Warning, ErrorCode.LOGIC_NUMBERED_KEY_RANGE);
    const count = values.get(pattern.maximum.toLowerCase());
    if (count) { diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(count.uri, new vscode.Position(count.line, 0)), localize('checks.effectiveCount', 'Effective count: {0}', count.value))]; }
    return [diagnostic];
};

export const checkFilePurpose: ValidationRule = (context: RuleContext) => {
    const property = parsePropertyLine(context.codePart);
    if (!property || !context.project) { return []; }
    const definition = context.schemaManager.getProperty(context.currentSection.typeName ?? '', property.key);
    const expected = definition?.fileType?.toLowerCase(), actual = context.project.category(context.document.uri);
    if (!expected || !['rules', 'art', 'sound', 'ai', 'eva', 'ui', 'theme'].includes(actual) || expected === actual) { return []; }
    return [new IniDiagnostic(new vscode.Range(context.lineNumber, property.keyStart, context.lineNumber, property.keyEnd),
        localize('checks.filePurpose', 'The dictionary declares {0} for {1}, but this file is classified as {2}. Check the declaration or file category.', property.key, expected, actual), vscode.DiagnosticSeverity.Information, ErrorCode.LOGIC_FILE_PURPOSE)];
};

export function referenceCategory(schema: SchemaManager, type: string, fallback: string): string {
    if (type === 'Sound') { return 'sound'; }
    if (schema.isAssignable(type, 'AnimType') || schema.isAssignable(type, 'VoxelAnimType')) { return 'art'; }
    return fallback === 'art' && schema.isComplexType(type) ? 'rules' : fallback;
}
