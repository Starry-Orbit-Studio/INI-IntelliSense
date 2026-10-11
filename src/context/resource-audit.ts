import * as vscode from 'vscode';
import { InspectionService } from './inspection-service';
import { parsePropertyLine } from './ini-position';
import { localize } from '../i18n';

/** On-demand validation uses exactly the resolver used by interactive previews. */
export class ResourceAudit implements vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('ra2-media');
    private readonly registration: vscode.Disposable;
    private revision = 0;

    constructor(private readonly service: InspectionService) {
        this.registration = vscode.commands.registerCommand('ra2-ini-intellisense.auditResources', (uri?: vscode.Uri) => this.run(uri));
    }

    public async run(uri?: vscode.Uri): Promise<number> {
        const origin = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!origin) {
            return 0;
        }
        const revision = ++this.revision;
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: localize('workbench.audit', 'Check project resources'),
                cancellable: true,
            },
            async (progress, token) => {
                await this.service.ini.load(origin);
                const files = this.service.ini.documents(origin);
                const jobs: { document: vscode.TextDocument; line: number; character: number }[] = [];
                for (const file of files) {
                    if (token.isCancellationRequested || revision !== this.revision) {
                        return 0;
                    }
                    const document = await vscode.workspace.openTextDocument(file.uri);
                    for (let line = 0; line < document.lineCount; line++) {
                        if (!this.service.isReference(document, line)) {
                            continue;
                        }
                        const property = parsePropertyLine(document.lineAt(line).text)!;
                        for (const span of property.elements.filter((item) => item.value)) {
                            jobs.push({ document, line, character: span.start });
                            if (jobs.length >= 2000) {
                                break;
                            }
                        }
                        if (jobs.length >= 2000) {
                            break;
                        }
                    }
                    if (jobs.length >= 2000) {
                        break;
                    }
                }
                const results = new Map<
                    string,
                    { uri: vscode.Uri; version: number; diagnostics: vscode.Diagnostic[] }
                >();
                let found = 0;
                for (let index = 0; index < jobs.length; index++) {
                    if (token.isCancellationRequested || revision !== this.revision) {
                        return found;
                    }
                    const job = jobs[index],
                        version = job.document.version;
                    progress.report({
                        message: localize('workbench.auditProgress', '{0}/{1} references', index + 1, jobs.length),
                        increment: 100 / Math.max(1, jobs.length),
                    });
                    try {
                        const session = await this.service.inspect(
                            job.document,
                            new vscode.Position(job.line, job.character),
                            token
                        );
                        if (job.document.version !== version) {
                            continue;
                        }
                        const key = job.document.uri.toString(),
                            result = results.get(key) ?? { uri: job.document.uri, version, diagnostics: [] };
                        for (const warning of session?.inspection.warnings ?? []) {
                            if (
                                result.diagnostics.some(
                                    (item) => item.range.start.line === job.line && item.message === warning
                                )
                            ) {
                                continue;
                            }
                            const diagnostic = new vscode.Diagnostic(
                                job.document.lineAt(job.line).range,
                                warning,
                                vscode.DiagnosticSeverity.Warning
                            );
                            diagnostic.source = 'RA2 Asset Workbench';
                            diagnostic.code = 'resource-resolution';
                            result.diagnostics.push(diagnostic);
                            found++;
                        }
                        results.set(key, result);
                    } catch (error) {
                        if (token.isCancellationRequested) {
                            return found;
                        }
                        console.error('[ResourceAudit] Reference inspection failed', error);
                    }
                }
                if (token.isCancellationRequested || revision !== this.revision) {
                    return found;
                }
                this.diagnostics.clear();
                for (const result of results.values()) {
                    const current = vscode.workspace.textDocuments.find(
                        (document) => document.uri.toString() === result.uri.toString()
                    );
                    if (current?.version === result.version) {
                        this.diagnostics.set(result.uri, result.diagnostics);
                    }
                }
                void vscode.window.showInformationMessage(
                    localize(
                        'workbench.auditResult',
                        'Checked {0} references; found {1} resource issues.',
                        jobs.length,
                        found
                    ) +
                        (jobs.length >= 2000
                            ? ' ' + localize('workbench.auditLimit', 'The audit reached its 2,000-reference limit.')
                            : '')
                );
                return found;
            }
        );
    }

    public dispose(): void {
        this.revision++;
        this.registration.dispose();
        this.diagnostics.dispose();
    }
}
