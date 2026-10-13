import * as vscode from 'vscode';
import { InspectionService, InspectionSession } from '../context/inspection-service';
import { CatalogObject } from '../context/object-catalog';
import { CATALOG_GROUPS, catalogGroup, GAME_GROUPS } from '../context/catalog-groups';
import { workbenchLabels } from '../context/workbench-labels';
import { localize } from '../i18n';
import { displayType } from '../type-display';

class ProjectItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly kind: string,
        public readonly origin: vscode.Uri,
        public readonly group = '',
        public readonly offset = 0
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

/** Native navigation stays lightweight; catalog snapshots and media are loaded only on demand. */
export class ProjectWorkbench implements vscode.TreeDataProvider<ProjectItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<ProjectItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly snapshots = new Map<string, Promise<InspectionSession>>();
    private readonly cancellation = new vscode.CancellationTokenSource();
    private refreshTimer?: NodeJS.Timeout;
    private recent: { origin: vscode.Uri; object: CatalogObject }[] = [];

    constructor(private readonly service: InspectionService) {
        const refresh = () => {
            this.snapshots.clear();
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => this.changed.fire(undefined), 350);
        };
        this.subscriptions.push(
            this.changed,
            this.cancellation,
            vscode.window.createTreeView('ra2-project-workbench', { treeDataProvider: this, showCollapseAll: true }),
            service.resources.onDidChange(refresh),
            vscode.workspace.onDidChangeWorkspaceFolders(refresh),
            vscode.window.onDidChangeActiveTextEditor(() => {
                if (!vscode.workspace.workspaceFolders?.length) {
                    refresh();
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId === 'ra2-ini') {
                    refresh();
                }
            }),
            vscode.commands.registerCommand('ra2-ini-intellisense.refreshProject', refresh),
            vscode.commands.registerCommand('ra2-ini-intellisense.openObjectDefinition', async (item?: ProjectItem) => {
                const object = item?.command?.arguments?.[1] as CatalogObject | undefined;
                if (object && item) {
                    const current = [...(await this.catalog(item.origin)).objects!.values()].find(
                        (candidate) => candidate.name === object.name && candidate.category === object.category
                    );
                    if (!current) {
                        this.changed.fire(undefined);
                        return;
                    }
                    const position = new vscode.Position(current.source.section.startLine, 0);
                    await vscode.window.showTextDocument(current.source.document.uri, {
                        selection: new vscode.Range(position, position),
                    });
                }
            }),
            vscode.commands.registerCommand('ra2-ini-intellisense.searchObjects', (uri?: vscode.Uri) =>
                this.search(uri)
            ),
            vscode.commands.registerCommand(
                'ra2-ini-intellisense.projectPreview',
                async (uri: vscode.Uri, object: CatalogObject) => {
                    const current = [...(await this.catalog(uri)).objects!.values()].find(
                        (candidate) => candidate.name === object.name && candidate.category === object.category
                    );
                    if (!current) {
                        this.changed.fire(undefined);
                        return;
                    }
                    object = current;
                    this.recent = [
                        { origin: uri, object },
                        ...this.recent.filter(
                            (item) =>
                                item.origin.toString() !== uri.toString() ||
                                item.object.name !== object.name ||
                                item.object.category !== object.category
                        ),
                    ].slice(0, 20);
                    this.changed.fire(undefined);
                    await vscode.commands.executeCommand(
                        'ra2-ini-intellisense.inspect',
                        object.source.document.uri.toString(),
                        object.source.section.startLine,
                        0
                    );
                }
            )
        );
    }

    public getTreeItem(item: ProjectItem): vscode.TreeItem {
        return item;
    }

    private roots(): vscode.Uri[] {
        const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
        const active = vscode.window.activeTextEditor?.document;
        if (!folders.length && active?.uri.scheme === 'file') {
            folders.push(this.service.resources.projectRoot(active.uri));
        }
        return [...new Map(folders.map((uri) => [uri.toString(), uri])).values()];
    }

    private async catalog(origin: vscode.Uri): Promise<InspectionSession> {
        const key = origin.toString();
        let pending = this.snapshots.get(key);
        if (pending && !(await pending).isCurrent?.()) {
            pending = undefined;
        }
        if (!pending) {
            pending = this.service.catalog(origin, this.cancellation.token);
            this.snapshots.set(key, pending);
            void pending.catch(() => {
                if (this.snapshots.get(key) === pending) {
                    this.snapshots.delete(key);
                }
            });
        }
        return pending;
    }

    private node(
        origin: vscode.Uri,
        label: string,
        kind: string,
        icon: string,
        command?: string,
        args?: unknown[]
    ): ProjectItem {
        const item = new ProjectItem(label, kind, origin);
        item.id = origin.toString() + ':' + kind;
        item.iconPath = new vscode.ThemeIcon(icon);
        if (command) {
            item.command = { command, title: label, arguments: args ?? [origin] };
        }
        return item;
    }

    private objectItem(origin: vscode.Uri, object: CatalogObject, parent = ''): ProjectItem {
        const item = this.node(
            origin,
            object.label || object.name,
            parent + ':object:' + object.category + ':' + object.name,
            catalogGroup(object) === 'sounds' ? 'unmute' : 'symbol-class',
            'ra2-ini-intellisense.projectPreview',
            [origin, object]
        );
        item.description = object.label ? object.name : undefined;
        item.tooltip = [
            object.label,
            object.name,
            workbenchLabels()['group_' + catalogGroup(object)],
            this.service.resources.label(origin, object.source.document.uri),
        ]
            .filter(Boolean)
            .join('\n');
        item.contextValue = 'ra2-project-object';
        return item;
    }

    public async getChildren(parent?: ProjectItem): Promise<ProjectItem[]> {
        try {
            return await this.children(parent);
        } catch (error) {
            console.error('[ProjectWorkbench]', error);
            const origin = parent?.origin ?? this.roots()[0];
            if (!origin) {
                return [];
            }
            const item = this.node(
                origin,
                localize('project.loadFailed', 'Could not load project. Refresh to retry.'),
                'error',
                'warning',
                'ra2-ini-intellisense.refreshProject'
            );
            item.tooltip = String(error);
            return [item];
        }
    }

    private async children(parent?: ProjectItem): Promise<ProjectItem[]> {
        const labels = workbenchLabels();
        if (!parent) {
            const roots = this.roots();
            if (roots.length === 1) {
                return this.navigation(roots[0]);
            }
            return roots.map((uri) => {
                const item = this.node(uri, uri.path.split('/').at(-1) || uri.fsPath, 'root', 'root-folder');
                item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                return item;
            });
        }
        if (parent.kind === 'root') {
            return this.navigation(parent.origin);
        }
        if (parent.kind === 'game' || parent.kind === 'effects') {
            const session = await this.catalog(parent.origin);
            return CATALOG_GROUPS.filter((group) =>
                parent.kind === 'game'
                    ? GAME_GROUPS.includes(group)
                    : !GAME_GROUPS.includes(group) && !['sounds', 'other'].includes(group)
            ).map((group) => {
                const node = new ProjectItem(labels['group_' + group], 'group', parent.origin, group);
                node.id = parent.id + ':' + group;
                node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                node.iconPath = new vscode.ThemeIcon('symbol-class');
                node.description = String(
                    [...session.objects!.values()].filter((object) => catalogGroup(object) === group).length
                );
                return node;
            });
        }
        if (parent.kind === 'recent') {
            return this.recent
                .filter((item) => item.origin.toString() === parent.origin.toString())
                .map((item) => this.objectItem(item.origin, item.object, 'recent'));
        }
        try {
            if (parent.kind === 'maps') {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(this.service.resources.projectRoot(parent.origin), '**/*.{map,mpr,yrm}'),
                    '**/{node_modules,.git,Tools}/**'
                );
                return files
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map((uri) => {
                        const item = this.node(
                            parent.origin,
                            uri.path.split('/').at(-1)!,
                            'map:' + uri.toString(),
                            'map',
                            'ra2-ini-intellisense.previewMap',
                            [uri]
                        );
                        item.description = this.service.resources.label(parent.origin, uri);
                        item.tooltip = item.description;
                        return item;
                    });
            }
            if (parent.kind === 'group') {
                const session = await this.catalog(parent.origin);
                const rows = [...session.objects!.values()]
                    .filter((object) => catalogGroup(object) === parent.group)
                    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, undefined, { numeric: true }));
                const items = rows
                    .slice(parent.offset, parent.offset + 100)
                    .map((object) => this.objectItem(parent.origin, object));
                items.unshift(
                    this.node(
                        parent.origin,
                        labels.openCatalog,
                        'list:' + parent.group + ':' + parent.offset,
                        'list-flat',
                        'ra2-ini-intellisense.browseObjects',
                        [parent.origin, parent.group]
                    )
                );
                if (rows.length > parent.offset + 100) {
                    const more = new ProjectItem(
                        labels.nextPage + ' · ' + (rows.length - parent.offset - 100),
                        'group',
                        parent.origin,
                        parent.group,
                        parent.offset + 100
                    );
                    more.id = parent.id + ':next';
                    more.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                    items.push(more);
                }
                return items;
            }
        } catch (error) {
            console.error('[ProjectWorkbench]', error);
            const item = this.node(
                parent.origin,
                localize('project.loadFailed', 'Could not load project. Refresh to retry.'),
                'error',
                'warning',
                'ra2-ini-intellisense.refreshProject'
            );
            item.tooltip = String(error);
            return [item];
        }
        return [];
    }

    private navigation(origin: vscode.Uri): ProjectItem[] {
        const labels = workbenchLabels();
        const items = [
            this.node(
                origin,
                this.service.resources.projectRoot(origin).path.split('/').at(-1) || origin.fsPath,
                'overview',
                'home',
                'ra2-ini-intellisense.projectOverview'
            ),
            this.node(origin, labels.searchObjects, 'search', 'search', 'ra2-ini-intellisense.searchObjects'),
            this.node(origin, labels.group_game, 'game', 'symbol-class'),
            this.node(origin, labels.effects, 'effects', 'sparkle'),
            this.node(origin, labels.group_sounds, 'group', 'unmute'),
            this.node(origin, labels.projectMaps, 'maps', 'map'),
            this.node(origin, labels.library, 'assets', 'file-media', 'ra2-ini-intellisense.browseAssets'),
            this.node(origin, labels.favorites, 'favorites', 'star', 'ra2-ini-intellisense.browseObjects', [
                origin,
                'favorites',
            ]),
            this.node(origin, labels.recentObjects, 'recent', 'history'),
            this.node(origin, labels.group_other, 'other', 'symbol-misc', 'ra2-ini-intellisense.browseObjects', [
                origin,
                'other',
            ]),
            this.node(origin, labels.logicChain, 'logic', 'references', 'ra2-ini-intellisense.logicChain'),
            this.node(origin, labels.audit, 'audit', 'checklist', 'ra2-ini-intellisense.auditResources'),
            this.node(origin, labels.checkCenter, 'checks', 'check', 'ra2-ini-intellisense.checkCenter'),
            this.node(origin, localize('dictionary.editor.title', 'Dictionary editor'), 'dictionary', 'book', 'ra2-ini-intellisense.editDictionary'),
            this.node(
                origin,
                labels.projectSettings,
                'settings',
                'settings-gear',
                'ra2-ini-intellisense.projectOverview'
            ),
        ];
        for (const item of items) {
            if (['game', 'effects', 'group', 'maps', 'recent'].includes(item.kind)) {
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            }
        }
        const sounds = items[4];
        // Keep immutable navigation keys independent from localized labels.
        return items.map((item) =>
            item === sounds
                ? Object.assign(new ProjectItem(item.label as string, 'group', origin, 'sounds'), {
                      id: item.id,
                      iconPath: item.iconPath,
                      collapsibleState: item.collapsibleState,
                  })
                : item
        );
    }

    private async search(uri?: vscode.Uri): Promise<void> {
        let origin = uri;
        if (!origin) {
            const roots = this.roots();
            origin =
                roots.length === 1
                    ? roots[0]
                    : (await vscode.window.showQuickPick(roots.map((root) => ({ label: root.fsPath, root }))))?.root;
        }
        if (!origin) {
            return;
        }
        const labels = workbenchLabels(),
            root = origin;
        const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { object?: CatalogObject }>();
        picker.placeholder = labels.searchObjects;
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.busy = true;
        picker.show();
        let alive = true;
        const hidden = picker.onDidHide(() => {
            alive = false;
            picker.dispose();
            hidden.dispose();
        });
        try {
            const session = await this.catalog(root);
            if (!alive) {
                return;
            }
            const objects = [...session.objects!.values()];
            const searchText = new Map(
                objects.map((object) => [
                    object,
                    (
                        object.name +
                        ' ' +
                          object.label +
                          ' ' +
                          object.type +
                          ' ' +
                          displayType(object.type) +
                          ' ' +
                          labels['group_' + catalogGroup(object)] +
                        ' ' +
                        this.service.resources.label(root, object.source.document.uri)
                    ).toLowerCase(),
                ])
            );
            const draw = () => {
                const query = picker.value.trim().toLowerCase();
                const terms = query.split(/\s+/).filter(Boolean);
                const results = objects.filter((object) =>
                    terms.length
                        ? terms.every((term) => searchText.get(object)!.includes(term))
                        : GAME_GROUPS.includes(catalogGroup(object))
                );
                results.sort(
                    (a, b) =>
                        Number(b.name.toLowerCase() === query) - Number(a.name.toLowerCase() === query) ||
                        CATALOG_GROUPS.indexOf(catalogGroup(a)) - CATALOG_GROUPS.indexOf(catalogGroup(b)) ||
                        a.name.localeCompare(b.name)
                );
                picker.items = results.slice(0, 200).map((object) => ({
                    label: object.label || object.name,
                    description: object.name,
                    detail: labels['group_' + catalogGroup(object)],
                    object,
                }));
                picker.title =
                    labels.searchObjects +
                    ' · ' +
                    results.length +
                    (results.length > 200 ? ' (' + labels.refineSearch + ')' : '');
            };
            picker.onDidChangeValue(draw);
            picker.onDidAccept(() => {
                const object = picker.selectedItems[0]?.object;
                if (object) {
                    picker.hide();
                    void vscode.commands.executeCommand('ra2-ini-intellisense.projectPreview', root, object);
                }
            });
            picker.busy = false;
            draw();
        } catch (error) {
            picker.hide();
            void vscode.window.showErrorMessage(
                localize('project.loadError', 'Could not load project: {0}', String(error))
            );
        }
    }

    public dispose(): void {
        clearTimeout(this.refreshTimer);
        this.cancellation.cancel();
        this.subscriptions.forEach((item) => item.dispose());
        this.snapshots.clear();
    }
}
