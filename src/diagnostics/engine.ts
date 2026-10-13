import * as vscode from 'vscode';
import { IniDiagnostic } from './diagnostic';
import { ErrorCode } from './error-codes';
import { SchemaManager } from '../schema-manager';
import { IniDocument, INIManager } from '../parser';
import { ProjectIni } from '../context/project-ini';
import { parsePropertyLine } from '../context/ini-position';
import { compileFileCategoryGlob } from '../file-type-manager';
import { styleRules } from './rules/style-rules';
import { typeRules } from './rules/type-rules';
import { logicRules } from './rules/logic-rules';
import { structuralRules, checkNumberedKey, checkFilePurpose } from './rules/context-rules';
import { rulePolicy } from './rule-catalog';
import { localize } from '../i18n';

/** Versioned, cancellable validation shared by live editing and the check center. */
export class DiagnosticManager implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('ra2-ini');
    private readonly generations = new Map<string, number>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    public project?: ProjectIni;
    constructor(
        context: vscode.ExtensionContext,
        private readonly schema: SchemaManager,
        private readonly manager: INIManager
    ) {
        this.subscriptions = [
            vscode.workspace.onDidCloseTextDocument((document) => this.clear(document.uri)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration('ra2-ini-intellisense.diagnostics') ||
                    event.affectsConfiguration('ra2-ini-intellisense.project') ||
                    event.affectsConfiguration('ra2-ini-intellisense.indexing') ||
                    event.affectsConfiguration('ra2-ini-intellisense.schemaFilePath')
                ) {
                    for (const uri of this.generations.keys()) {
                        this.generations.set(uri, this.generations.get(uri)! + 1);
                    }
                    this.collection.clear();
                    this.changed.fire();
                    for (const document of vscode.workspace.textDocuments) {
                        this.handleDocumentChange(document);
                    }
                }
            }),
        ];
    }
    private clear(uri: vscode.Uri): void {
        const key = uri.toString();
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.collection.delete(uri);
        this.changed.fire();
    }
    public results(): { uri: vscode.Uri; diagnostics: readonly vscode.Diagnostic[] }[] {
        const result: { uri: vscode.Uri; diagnostics: readonly vscode.Diagnostic[] }[] = [];
        this.collection.forEach((uri, diagnostics) => result.push({ uri, diagnostics }));
        return result;
    }
    public handleDocumentChange(document: vscode.TextDocument, ranges?: vscode.Range[]): void {
        if (document.languageId !== 'ra2-ini') {
            return;
        }
        const key = document.uri.toString();
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        clearTimeout(this.timers.get(key));
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.validate(document).catch((error) => console.error('[Diagnostics] Validation failed', error));
            }, 250)
        );
    }
    public handleViewportChange(editor: vscode.TextEditor): void {
        // Scrolling does not invalidate whole-file, cross-line rules.
    }
    public async validate(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<readonly vscode.Diagnostic[]> {
        const uri = document.uri,
            key = uri.toString(),
            version = document.version;
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        const generation = (this.generations.get(key) ?? 0) + 1;
        this.generations.set(key, generation);
        const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics', uri);
        const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        if (
            this.schema.isDictionaryDocument(uri) ||
            !configuration.get('enabled', true) ||
            configuration
                .get<string[]>('excludePatterns', [])
                .some((pattern) => compileFileCategoryGlob(pattern).test(relative))
        ) {
            this.collection.delete(uri);
            this.changed.fire();
            return [];
        }
        await this.project?.load(uri);
        const stale = () =>
            token?.isCancellationRequested ||
            document.isClosed ||
            version !== document.version ||
            generation !== this.generations.get(key);
        if (stale()) {
            return [];
        }
        const model = this.project?.parse(document) ?? new IniDocument(uri, document.getText());
        const category = this.project?.category(uri) ?? this.manager.getFileType(uri);
        const policy = rulePolicy(uri);
        const base = {
            document,
            project: this.project,
            schemaManager: this.schema,
            iniManager: this.manager,
            config: configuration,
            disabledErrorCodes: new Set<string>(),
            severityOverrides: policy,
        };
        const result: IniDiagnostic[] = [];
        let sectionStart = -1,
            multiline = false;
        const seenRegistryKeys = new Set<string>(),
            seenKeys = new Set<string>();
        const types = new Map<string, { typeName: string; keys: ReturnType<SchemaManager['getAllKeysForType']> }>();
        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            if (lineNumber % 200 === 0) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                if (stale()) {
                    return [];
                }
            }
            const line = document.lineAt(lineNumber),
                quotes = (line.text.match(/"""/g) ?? []).length;
            if (multiline || quotes) {
                if (quotes % 2) {
                    multiline = !multiline;
                }
                continue;
            }
            const section = model.getSectionAt(lineNumber);
            if (section?.startLine !== sectionStart) {
                sectionStart = section?.startLine ?? -1;
                seenRegistryKeys.clear();
                seenKeys.clear();
            }
            if (section && !types.has(section.name)) {
                const typeName =
                    this.project?.type(uri, section.name, category) ??
                    this.manager.getTypeForSection(section.name, new Set(), category);
                types.set(section.name, { typeName, keys: this.schema.getAllKeysForType(typeName) });
            }
            const metadata = section ? types.get(section.name) : undefined;
            const typeName = metadata?.typeName ?? null,
                keys = metadata?.keys ?? null;
            const parsed = parsePropertyLine(line.text),
                commentIndex = parsed ? parsed.valueEnd : line.text.indexOf(';');
            const context = {
                ...base,
                line,
                lineNumber,
                codePart: commentIndex < 0 ? line.text : line.text.slice(0, commentIndex),
                commentPart:
                    commentIndex < 0 || commentIndex === line.text.length ? null : line.text.slice(commentIndex),
                currentSection: { name: section?.name ?? null, typeName, keys },
                seenRegistryKeys,
            };
            for (const rule of [...styleRules, ...typeRules, ...logicRules, checkNumberedKey, checkFilePurpose]) {
                result.push(...rule(context));
            }
            if (parsed && section && !['#include', 'description'].includes(section.name.toLowerCase())) {
                const normalized = parsed.key.toLowerCase();
                if (
                    seenKeys.has(normalized) &&
                    parsed.key !== '+' &&
                    !this.schema.getIdListRegistryNames().has(section.name)
                ) {
                    result.push(
                        new IniDiagnostic(
                            new vscode.Range(lineNumber, parsed.keyStart, lineNumber, parsed.keyEnd),
                            localize('checks.duplicateKey', 'This key replaces an earlier value in the same section.'),
                            vscode.DiagnosticSeverity.Information,
                            ErrorCode.LOGIC_DUPLICATE_KEY
                        )
                    );
                }
                seenKeys.add(normalized);
                if (
                    keys?.size &&
                    !this.schema.getTypeForRegistry(section.name) &&
                    !this.schema.getProperty(typeName ?? '', parsed.key) &&
                    !['inherits', '$inherits'].includes(normalized) &&
                    policy.get('L005') !== null
                ) {
                    result.push(
                        new IniDiagnostic(
                            new vscode.Range(lineNumber, parsed.keyStart, lineNumber, parsed.keyEnd),
                            localize(
                                'checks.unknownKey',
                                'The dictionary does not declare this key for type {0}. Check your dictionary and engine extensions.',
                                typeName
                            ),
                            vscode.DiagnosticSeverity.Hint,
                            ErrorCode.LOGIC_UNKNOWN_KEY
                        )
                    );
                }
            }
        }
        result.push(...structuralRules(document, model, this.project));
        const filtered = result.filter((diagnostic) => {
            const severity = policy.get(String(diagnostic.code));
            if (severity === null) {
                return false;
            }
            if (severity !== undefined) {
                diagnostic.severity = severity;
            }
            diagnostic.source = 'RA2 INI';
            return true;
        });
        if (!stale()) {
            this.collection.set(uri, filtered);
            this.changed.fire();
        }
        return filtered;
    }
    public dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.generations.clear();
        this.timers.clear();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.collection.dispose();
        this.changed.dispose();
    }
}
