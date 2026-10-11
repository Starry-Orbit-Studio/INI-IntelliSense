import type { Inspection, WorkbenchLabels } from '../../src/context/workbench-protocol';
import { CATALOG_GROUPS } from '../../src/context/catalog-groups';

/** Readable project facts; configuration writes use VS Code's scoped settings editor. */
export function projectView(
    host: HTMLElement,
    inspection: Inspection,
    labels: WorkbenchLabels,
    post: (type: string, data?: object) => void
): void {
    const project = inspection.project!;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
    };
    const button = (title: string, run: () => void) => {
        const node = make('button', title);
        node.type = 'button';
        node.onclick = run;
        return node;
    };
    const root = make('p', project.root);
    root.className = 'project-root';
    host.append(root);
    host.append(make('p', labels.projectOverviewHelp));
    const cards = make('section');
    cards.className = 'project-counts';
    for (const group of CATALOG_GROUPS) {
        const node = button(labels['group_' + group] + ' · ' + (project.counts[group] ?? 0), () =>
            post('catalog-scope', { value: group })
        );
        cards.append(node);
    }
    host.append(cards);
    const layout = make('div');
    layout.className = 'project-layout';
    host.append(layout);
    const settings = make('section');
    settings.className = 'project-card';
    settings.append(make('h2', labels.projectSettings), make('p', labels.projectSettingsHelp));
    for (const setting of project.settings) {
        const row = make('details');
        row.append(make('summary', labels['setting_' + setting.key] ?? setting.key));
        row.append(make('p', labels['help_' + setting.key] ?? ''));
        row.append(make('pre', setting.value));
        row.append(
            button(labels.editProperty, () =>
                post(setting.key === 'project.entryPoints' ? 'configure-project' : 'project-setting', {
                    key: setting.key,
                })
            )
        );
        settings.append(row);
    }
    layout.append(settings);
    const sources = make('section');
    sources.className = 'project-card';
    sources.append(make('h2', labels.projectSources), make('p', labels.resourcePriorityHelp));
    sources.append(
        make(
            'p',
            labels.looseResources + ' · ' + project.files + ' / ' + labels.archives + ' · ' + project.archives.length
        )
    );
    const documents = make('details');
    documents.append(make('summary', labels.documents + ' · ' + project.documents.length));
    const search = make('input');
    search.type = 'search';
    search.placeholder = labels.searchSources;
    search.setAttribute('aria-label', labels.searchSources);
    const list = make('div');
    list.className = 'project-source-list';
    const draw = () => {
        list.replaceChildren();
        const matches = project.documents.filter((document) =>
            document.label.toLowerCase().includes(search.value.toLowerCase())
        );
        matches
            .slice(0, 100)
            .forEach((document) => list.append(button(document.label, () => post('source', { id: document.id }))));
        if (matches.length > 100) {
            list.append(make('p', labels.refineSearch));
        }
    };
    search.oninput = draw;
    draw();
    documents.append(search, list);
    sources.append(documents);
    const archives = make('details');
    archives.append(make('summary', labels.archives + ' · ' + project.archives.length));
    const archiveList = make('div');
    archiveList.className = 'project-source-list';
    project.archives.forEach((archive) => archiveList.append(make('p', archive.source)));
    archives.append(archiveList);
    sources.append(archives);
    const errors = [...(inspection.resolution?.issues ?? []), ...project.errors];
    const status = make('details');
    status.open = errors.length > 0;
    status.append(make('summary', labels.projectIssues + ' · ' + errors.length));
    errors.forEach((error) => {
        const node = make('p', error);
        node.className = 'warning';
        status.append(node);
    });
    sources.append(status);
    layout.append(sources);
}
