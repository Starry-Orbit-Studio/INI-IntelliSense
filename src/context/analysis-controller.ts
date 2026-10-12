import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { InspectionService } from './inspection-service';
import { SchemaManager } from '../schema-manager';
import { DescriptionManager } from '../description-manager';
import { DiagnosticManager } from '../diagnostics/engine';
import { isSeverity, ruleCatalog, rulePolicy, ruleSource, SEVERITIES } from '../diagnostics/rule-catalog';
import { commandOrigin } from './command-origin';
import { workbenchHtml } from './workbench-html';
import { workbenchLabels } from './workbench-labels';
import { Inspection } from './workbench-protocol';
import { IndexedLogicGraph, indexLogic, logicSlice } from './logic-graph';
import { ConfigurationService } from './configuration-service';
import { configurationMessage } from './configuration-channel';
import { localize } from '../i18n';

interface AnalysisPage {
    panel: vscode.WebviewPanel;
    origin: vscode.Uri;
    currentFile?: vscode.Uri;
    cursorLine?: number;
    id: string;
    kind: 'checks' | 'logic';
    ready: boolean;
    revision: number;
    busy: boolean;
    checked: number;
    total: number;
    complete: boolean;
    scope: vscode.ConfigurationTarget;
    links: Map<string, vscode.Location>;
    configuration: ConfigurationService;
    results: Map<string, readonly vscode.Diagnostic[]>;
    graph?: IndexedLogicGraph;
    graphOrigin?: string;
    focus?: string;
    direction: string;
    depth: number;
    query?: string;
    error?: string;
    cancellation: vscode.CancellationTokenSource;
    queue: Promise<void>;
}

/** Native commands and webview mutations share scoped, validated configuration writes. */
export class AnalysisController implements vscode.Disposable {
    private readonly pages = new Map<string, AnalysisPage>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private timer?: NodeJS.Timeout;
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly service: InspectionService,
        private readonly schema: SchemaManager,
        private readonly descriptions: DescriptionManager,
        private readonly diagnostics: DiagnosticManager,
        private readonly translate: (key: string) => string | undefined = () => undefined
    ) {
        const refresh = () => {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                for (const page of this.pages.values()) {
                    if (!page.busy) {
                        this.send(page);
                    }
                }
            }, 150);
        };
        this.subscriptions.push(
            vscode.commands.registerCommand('ra2-ini-intellisense.checkCenter', (value) => this.open('checks', value)),
            vscode.commands.registerCommand('ra2-ini-intellisense.logicChain', (value) => this.open('logic', value)),
            diagnostics.onDidChange(refresh),
            vscode.workspace.onDidChangeConfiguration(() => {
                for (const page of this.pages.values()) {
                    page.results.clear();
                    page.complete = false;
                }
                refresh();
            }),
            vscode.workspace.onDidChangeTextDocument(() => {
                for (const page of this.pages.values()) {
                    page.results.clear();
                    page.complete = false;
                }
                refresh();
            })
        );
    }
    private async open(kind: AnalysisPage['kind'], value?: unknown): Promise<void> {
        const origin = commandOrigin(value);
        const editor = vscode.window.activeTextEditor;
        if (!origin) {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:Astralette.ra2-ini-intellisense'
            );
            return;
        }
        const key = kind + ':' + this.service.resources.projectRoot(origin).toString();
        let page = this.pages.get(key);
        if (!page) {
            const panel = vscode.window.createWebviewPanel(
                'ra2-' + kind,
                localize(
                    kind === 'checks' ? 'workbench.checkCenter' : 'workbench.logicChain',
                    kind === 'checks' ? 'INI check center' : 'Logic chain'
                ),
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist/workbench')],
                }
            );
            page = {
                panel,
                origin,
                id: randomUUID(),
                kind,
                ready: false,
                revision: 0,
                busy: false,
                checked: 0,
                total: 0,
                complete: false,
                scope: vscode.workspace.getWorkspaceFolder(origin)
                    ? vscode.ConfigurationTarget.WorkspaceFolder
                    : vscode.ConfigurationTarget.Global,
                links: new Map(),
                results: new Map(),
                configuration: new ConfigurationService(this.context.extensionUri),
                direction: 'both',
                depth: 1,
                cancellation: new vscode.CancellationTokenSource(),
                queue: Promise.resolve(),
            };
            this.pages.set(key, page);
            const entry = page;
            panel.webview.onDidReceiveMessage((message) => {
                entry.queue = entry.queue
                    .then(() => this.message(entry, message))
                    .catch((error) => {
                        if (!(error instanceof vscode.CancellationError)) {
                            console.error('[Analysis] Command failed', error);
                            entry.error = error instanceof Error ? error.message : String(error);
                            this.send(entry);
                        }
                    });
            });
            panel.onDidDispose(() => {
                entry.cancellation.cancel();
                entry.cancellation.dispose();
                this.pages.delete(key);
            });
            panel.webview.html = workbenchHtml(panel.webview, this.context.extensionUri);
        }
        if (page.origin.toString() !== origin.toString()) {
            page.graph = undefined;
            page.focus = undefined;
            page.currentFile = undefined;
        }
        page.origin = origin;
        if (/\.(ini|map|mpr|yrm)$/i.test(origin.path)) {
            page.currentFile = origin;
        } else if (
            editor?.document.languageId === 'ra2-ini' &&
            this.service.resources.contains(origin, editor.document.uri)
        ) {
            page.currentFile = editor.document.uri;
        }
        page.cursorLine =
            editor?.document.uri.toString() === page.currentFile?.toString() ? editor?.selection.active.line : 0;
        page.panel.reveal(undefined, true);
        if (kind === 'logic') {
            try {
                await this.rebuildLogic(page);
            } catch (error) {
                console.error('[Logic chain]', error);
                page.error = error instanceof Error ? error.message : String(error);
            }
        }
        this.send(page);
    }
    private send(page: AnalysisPage): void {
        if (!page.ready) {
            return;
        }
        const inspection: Inspection = {
            id: page.id,
            mediaRevision: ++page.revision,
            owner: localize(
                page.kind === 'checks' ? 'workbench.checkCenter' : 'workbench.logicChain',
                page.kind === 'checks' ? 'INI check center' : 'Logic chain'
            ),
            type: '',
            focus: '',
            properties: [],
            sources: [],
            references: [],
            assets: [],
            paletteOptions: [],
            warnings: [],
        };
        if (page.kind === 'checks') {
            page.links.clear();
            const configuration = vscode.workspace.getConfiguration(
                'ra2-ini-intellisense',
                page.currentFile ?? page.origin
            );
            const configurationModel = page.configuration.describe(page.currentFile ?? page.origin, ['checks', 'validator'], page.scope === vscode.ConfigurationTarget.Global ? 'user' : page.scope === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'folder');
            page.scope = configurationModel.scope === 'user' ? vscode.ConfigurationTarget.Global : configurationModel.scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder;
            const configured = configuration.inspect<Record<string, string>>('diagnostics.severity');
            const selected =
                page.scope === vscode.ConfigurationTarget.Global
                    ? configured?.globalValue
                    : page.scope === vscode.ConfigurationTarget.Workspace
                      ? configured?.workspaceValue
                      : configured?.workspaceFolderValue;
            const effective = rulePolicy(page.currentFile ?? page.origin);
            const issues: NonNullable<Inspection['checks']>['issues'] = [];
            const entries = new Map<string, { uri: vscode.Uri; values: readonly vscode.Diagnostic[] }>();
            for (const [key, values] of page.results) {
                entries.set(key, { uri: vscode.Uri.parse(key), values });
            }
            for (const [uri, values] of vscode.languages.getDiagnostics()) {
                const previous = entries.get(uri.toString())?.values ?? [];
                const other = values.filter((value) => value.source !== 'RA2 INI');
                const live = values.filter((value) => value.source === 'RA2 INI');
                entries.set(uri.toString(), { uri, values: [...(live.length ? live : previous), ...other] });
            }
            for (const { uri, values } of entries.values()) {
                if (!this.service.resources.contains(page.origin, uri)) {
                    continue;
                }
                for (const diagnostic of values) {
                    if (!['RA2 INI', 'INI Validator', 'RA2 Asset Workbench'].includes(diagnostic.source ?? '')) {
                        continue;
                    }
                    const id = randomUUID();
                    page.links.set(id, new vscode.Location(uri, diagnostic.range));
                    issues.push({
                        id,
                        source: vscode.workspace.asRelativePath(uri) + ':' + (diagnostic.range.start.line + 1),
                        code: String(
                            typeof diagnostic.code === 'object' ? diagnostic.code.value : (diagnostic.code ?? '')
                        ),
                        message: diagnostic.message,
                        severity: diagnostic.severity,
                        provider: diagnostic.source ?? '',
                    });
                }
            }
            inspection.checks = {
                enabled: configuration.get('diagnostics.enabled', true),
                scope:
                    page.scope === vscode.ConfigurationTarget.Global
                        ? 'user'
                        : page.scope === vscode.ConfigurationTarget.Workspace
                          ? 'workspace'
                          : 'folder',
                checked: page.checked,
                total: page.total,
                complete: page.complete,
                dictionary: configuration.get('schemaFilePath', '') ?? '',
                dictionaryReady: this.schema.isSchemaLoaded(),
                languages: this.descriptions.getLoadedLanguages(),
                rules: ruleCatalog().map((rule) => ({
                    ...rule,
                    configured: selected?.[rule.id],
                    source: ruleSource(page.currentFile ?? page.origin, rule.id),
                    effective: effective.get(rule.id) === null ? 'None' : SEVERITIES[effective.get(rule.id) ?? 0],
                })),
                issues,
                configuration: configurationModel,
            };
            inspection.resolution = this.service.ini.context(page.currentFile ?? page.origin);
        } else if (page.graph && page.focus) {
            inspection.logic = logicSlice(page.graph, page.focus, page.direction, page.depth);
            const terms = (page.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            inspection.logic.query = page.query;
            inspection.logic.stale = !page.graph.isCurrent();
            inspection.logic.choices = page.graph.nodes
                .filter((node) =>
                    terms.length
                        ? terms.every((term) =>
                              (
                                  node.name +
                                  ' ' +
                                  node.type +
                                  ' ' +
                                  node.category +
                                  ' ' +
                                  (node.label ?? '') +
                                  ' ' +
                                  (node.source ?? '')
                              )
                                  .toLowerCase()
                                  .includes(term)
                          )
                        : node.id === page.focus
                )
                .slice(0, 80);
            inspection.owner = page.graph.nodes.find((node) => node.id === page.focus)?.name ?? inspection.owner;
            inspection.resolution = this.service.ini.context(page.origin);
        }
        void page.panel.webview.postMessage({
            type: 'state',
            labels: workbenchLabels(),
            inspection,
            loading: page.busy,
            pinned: true,
            error: page.error,
        });
    }
    private async rebuildLogic(page: AnalysisPage): Promise<void> {
        const origin = page.currentFile ?? page.origin;
        page.busy = true;
        page.error = undefined;
        this.send(page);
        try {
            if (!page.graph?.isCurrent() || page.graphOrigin !== origin.toString()) {
                page.graph = await indexLogic(
                    this.service.ini,
                    this.schema,
                    origin,
                    page.cancellation.token,
                    this.translate
                );
                page.graphOrigin = origin.toString();
            }
            const document = page.currentFile ? await vscode.workspace.openTextDocument(page.currentFile) : undefined;
            const line = page.cursorLine ?? 0;
            const section = document && this.service.ini.parse(document).getSectionAt(line);
            page.focus =
                !page.focus && section
                    ? this.service.ini.category(document!.uri) + ':' + section.name.toLowerCase()
                    : page.focus;
            if (!page.graph.nodes.some((node) => node.id === page.focus)) {
                page.focus = page.graph.nodes[0]?.id;
            }
        } finally {
            page.busy = false;
            this.send(page);
        }
    }
    private async message(page: AnalysisPage, message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const data = message as {
            type?: string;
            inspection?: string;
            id?: string;
            key?: string;
            value?: unknown;
            scope?: string;
        };
        if (data.type === 'ready') {
            page.ready = true;
            this.send(page);
            return;
        }
        if (data.inspection !== page.id) {
            return;
        }
        page.error = undefined;
        if (page.kind === 'checks' && await configurationMessage({
            service: page.configuration, origin: page.currentFile ?? page.origin, root: this.service.resources.projectRoot(page.origin),
            scope: page.scope === vscode.ConfigurationTarget.Global ? 'user' : page.scope === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'folder',
            groups: ['checks', 'validator'], setScope: scope => { page.scope = scope === 'user' ? vscode.ConfigurationTarget.Global : scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder; },
            post: message => { void page.panel.webview.postMessage(message); }, refresh: () => this.send(page), editing: () => undefined,
        }, message)) { return; }

        if (data.type === 'source' && typeof data.id === 'string') {
            const location = page.kind === 'logic' ? page.graph?.locations.get(data.id) : page.links.get(data.id);
            if (location) {
                await vscode.window.showTextDocument(location.uri, { selection: location.range });
            }
        } else if (data.type === 'analysis-scope') {
            if (data.value === 'user') {
                page.scope = vscode.ConfigurationTarget.Global;
            } else if (data.value === 'workspace' && vscode.workspace.workspaceFolders?.length) {
                page.scope = vscode.ConfigurationTarget.Workspace;
            } else if (data.value === 'folder' && vscode.workspace.getWorkspaceFolder(page.origin)) {
                page.scope = vscode.ConfigurationTarget.WorkspaceFolder;
            }
        } else if (
            data.type === 'rule-level' &&
            ruleCatalog().some((rule) => rule.id === data.id) &&
            (data.value === 'inherit' || isSeverity(data.value))
        ) {
            const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', page.origin);
            const details = configuration.inspect<Record<string, string>>('diagnostics.severity');
            const raw = {
                ...(page.scope === vscode.ConfigurationTarget.Global
                    ? details?.globalValue
                    : page.scope === vscode.ConfigurationTarget.Workspace
                      ? details?.workspaceValue
                      : details?.workspaceFolderValue),
            };
            if (data.value === 'inherit') {
                delete raw[data.id!];
            } else {
                raw[data.id!] = data.value as string;
            }
            await configuration.update('diagnostics.severity', Object.keys(raw).length ? raw : undefined, page.scope);
        } else if (
            data.type === 'check-preset' &&
            ['compatible', 'correctness', 'strict', 'quiet'].includes(String(data.value))
        ) {
            const configuration = vscode.workspace.getConfiguration('ra2-ini-intellisense', page.origin);
            await configuration.update('diagnostics.enabled', data.value !== 'quiet', page.scope);
            const values = Object.fromEntries(
                ruleCatalog().map((rule) => [
                    rule.id,
                    data.value === 'correctness' && rule.group === 'S'
                        ? 'None'
                        : data.value === 'strict' && rule.severity === 'None'
                          ? 'Warning'
                          : rule.severity,
                ])
            );
            await configuration.update('diagnostics.severity', values, page.scope);
        } else if (data.type === 'project-settings') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.projectOverview', page.origin);
        } else if (data.type === 'run-validator') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.runValidator', page.currentFile ?? page.origin);
        } else if (data.type === 'native-settings') {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:Astralette.ra2-ini-intellisense'
            );
        } else if (data.type === 'configure-file') {
            await vscode.commands.executeCommand(
                'ra2-ini-intellisense.configureFileCategory',
                page.currentFile ?? page.origin
            );
        } else if (data.type === 'configure-project') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.configureProject', page.origin);
        } else if (data.type === 'dictionary-update') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.downloadDictionary');
        } else if (data.type === 'external-validator') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.manageValidator');
        } else if (data.type === 'resource-audit') {
            await vscode.commands.executeCommand('ra2-ini-intellisense.auditResources', page.origin);
        } else if (data.type === 'run-checks') {
            await this.run(page, data.value === 'project');
        } else if (data.type === 'logic-options' && data.value && typeof data.value === 'object') {
            const options = data.value as { focus?: string; direction?: string; depth?: number };
            if (page.graph?.nodes.some((node) => node.id === options.focus)) {
                page.focus = options.focus;
            }
            if (['both', 'upstream', 'downstream'].includes(options.direction ?? '')) {
                page.direction = options.direction!;
            }
            if (Number.isInteger(options.depth) && options.depth! >= 1 && options.depth! <= 5) {
                page.depth = options.depth!;
            }
        } else if (data.type === 'logic-search' && typeof data.value === 'string' && data.value.length <= 200) {
            page.query = data.value;
        } else if (data.type === 'refresh' && page.kind === 'logic') {
            await this.rebuildLogic(page);
        }
        this.send(page);
    }
    private async run(page: AnalysisPage, project: boolean): Promise<void> {
        page.busy = true;
        page.complete = false;
        page.checked = 0;
        page.results.clear();
        this.send(page);
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: localize('workbench.checkCenter', 'INI check center'),
                    cancellable: true,
                },
                async (progress, token) => {
                    const origin = project ? this.service.resources.projectRoot(page.origin) : page.currentFile;
                    if (!origin) {
                        return;
                    }
                    await this.service.ini.load(origin);
                    const snapshot = this.service.ini.snapshot(origin);
                    const files = project
                        ? this.service.ini.documents(origin).map((document) => document.uri)
                        : [origin];
                    page.total = files.length;
                    for (const uri of files) {
                        if (token.isCancellationRequested || page.cancellation.token.isCancellationRequested) {
                            break;
                        }
                        progress.report({
                            message: vscode.workspace.asRelativePath(uri),
                            increment: 100 / Math.max(1, files.length),
                        });
                        const document = await vscode.workspace.openTextDocument(uri);
                        const results = await this.diagnostics.validate(document, token);
                        if (token.isCancellationRequested || !snapshot.isCurrent()) {
                            break;
                        }
                        page.results.set(uri.toString(), results);
                        page.checked++;
                        this.send(page);
                    }
                    page.complete =
                        page.checked === page.total &&
                        this.service.ini.context(origin).complete &&
                        snapshot.isCurrent() &&
                        !token.isCancellationRequested;
                }
            );
        } finally {
            page.busy = false;
            this.send(page);
        }
    }
    public dispose(): void {
        clearTimeout(this.timer);
        this.subscriptions.forEach((item) => item.dispose());
        for (const page of [...this.pages.values()]) {
            page.panel.dispose();
        }
    }
}
