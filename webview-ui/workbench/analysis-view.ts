import type { Inspection, WorkbenchLabels } from '../../src/context/workbench-protocol';
import { displayType } from '../../src/type-display';

let query = '',
    tab = 'results';
let graphDraft: { id: string; value: string } | undefined;
/** DOM-only views keep project text inert and preserve search while results refresh. */
export function analysisView(
    host: HTMLElement,
    inspection: Inspection,
    labels: WorkbenchLabels,
    post: (type: string, data?: object) => void
): void {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
    };
    const button = (label: string, action: () => void) => {
        const node = make('button', label);
        node.type = 'button';
        node.onclick = action;
        return node;
    };
    const select = (choices: [string, string][], value: string, change: (value: string) => void) => {
        const node = make('select');
        for (const [id, label] of choices) {
            const option = make('option', label);
            option.value = id;
            node.append(option);
        }
        node.value = value;
        node.onchange = () => change(node.value);
        return node;
    };
    const toolbar = make('div');
    toolbar.className = 'analysis-toolbar';
    host.append(toolbar);
    const checks = inspection.checks;
    if (checks) {
        const scope = select(
            [
                ['folder', labels.scopeFolder],
                ['workspace', labels.scopeWorkspace],
                ['user', labels.scopeUser],
            ],
            checks.scope,
            (value) => post('analysis-scope', { value })
        );
        scope.setAttribute('aria-label', labels.saveScope);
        toolbar.append(
            scope,
            button(labels.runCurrent, () => post('run-checks', { value: 'current' })),
            button(labels.runProject, () => post('run-checks', { value: 'project' })),
            button(labels.nativeSettings, () => post('native-settings'))
        );
        const coverage = make(
            'p',
            (checks.enabled ? '' : labels.checksDisabled + ' · ') +
                (checks.complete ? labels.checkComplete : labels.checkPartial) +
                ' · ' +
                checks.checked +
                '/' +
                checks.total
        );
        coverage.className = 'analysis-status';
        host.append(coverage);
        const tabs = make('nav');
        tabs.className = 'analysis-tabs';
        for (const [id, title] of [
            ['results', labels.checkResults],
            ['rules', labels.checkRules],
            ['settings', labels.projectSettings],
        ]) {
            const node = button(title, () => {
                tab = id;
                draw();
            });
            node.dataset.tab = id;
            tabs.append(node);
        }
        host.append(tabs);
        const search = make('input');
        search.type = 'search';
        search.value = query;
        search.placeholder = labels.searchChecks;
        search.setAttribute('aria-label', labels.searchChecks);
        host.append(search);
        const content = make('section');
        content.className = 'analysis-content';
        host.append(content);
        const draw = () => {
            content.replaceChildren();
            tabs.querySelectorAll('button').forEach((node) =>
                node.setAttribute('aria-pressed', String(node.dataset.tab === tab))
            );
            const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
            const matches = (...values: string[]) =>
                terms.every((term) => values.join(' ').toLowerCase().includes(term));
            if (tab === 'results') {
                const issues = checks.issues.filter((issue) =>
                    matches(issue.message, issue.source, issue.code, issue.provider)
                );
                content.append(make('p', labels.checkResults + ' · ' + issues.length));
                if (!issues.length) {
                    content.append(make('p', checks.checked ? labels.noIssues : labels.noResults));
                }
                for (const issue of issues.slice(0, 200)) {
                    const row = make('article');
                    row.className = 'analysis-issue severity-' + issue.severity;
                    row.append(
                        button(issue.source + ' · ' + issue.code, () => post('source', { id: issue.id })),
                        make('p', issue.message),
                        make('small', issue.provider)
                    );
                    content.append(row);
                }
                if (issues.length > 200) {
                    content.append(make('p', labels.refineSearch));
                }
            } else if (tab === 'rules') {
                const presets = make('div');
                presets.className = 'analysis-toolbar';
                for (const [id, name] of [
                    ['compatible', labels.presetCompatible],
                    ['correctness', labels.presetCorrectness],
                    ['strict', labels.presetStrict],
                    ['quiet', labels.presetQuiet],
                ]) {
                    presets.append(button(name, () => post('check-preset', { value: id })));
                }
                content.append(presets, make('p', labels.ruleHelp));
                const table = make('div');
                table.className = 'rule-list';
                for (const rule of checks.rules.filter((rule) => matches(rule.name, rule.id))) {
                    const row = make('article');
                    row.className = 'rule-row';
                    const info = make('div');
                    info.append(
                        make('strong', rule.name),
                        make(
                            'small',
                            rule.id +
                                ' · ' +
                                labels.effective +
                                ': ' +
                                labels['level_' + rule.effective] +
                                ' · ' +
                                labels.default +
                                ': ' +
                                labels['level_' + rule.severity]
                        )
                    );
                    const choices: [string, string][] = [
                        ['inherit', labels.inheritSetting],
                        ...['Error', 'Warning', 'Information', 'Hint', 'None'].map(
                            (id) => [id, labels['level_' + id]] as [string, string]
                        ),
                    ];
                    const level = select(choices, rule.configured ?? 'inherit', (value) =>
                        post('rule-level', { id: rule.id, value })
                    );
                    level.setAttribute('aria-label', rule.name);
                    row.append(info, level);
                    table.append(row);
                }
                content.append(table);
            } else {
                const dictionary = make('article');
                dictionary.className = 'project-card';
                dictionary.append(
                    make('h2', labels.dictionary),
                    make('p', checks.dictionary || labels.dictionaryMissing),
                    make(
                        'p',
                        labels.descriptionLanguages + ': ' + (checks.languages.join(', ') || labels.dictionaryMissing)
                    ),
                    button(labels.updateDictionary, () => post('dictionary-update')),
                    button(labels.externalValidator, () => post('external-validator')),
                    button(labels.audit, () => post('resource-audit')),
                    button(labels.projectEntries, () => post('configure-project')),
                    button(labels.configureFileCategory, () => post('configure-file'))
                );
                content.append(dictionary);
                for (const setting of checks.settings.filter((setting) =>
                    matches(setting.key, labels['setting_' + setting.key] ?? '', setting.value)
                )) {
                    const row = make('details');
                    row.className = 'setting-row';
                    row.append(
                        make('summary', labels['setting_' + setting.key] ?? setting.key),
                        make('pre', setting.value),
                        button(labels.editProperty, () => post('edit-setting', { key: setting.key }))
                    );
                    content.append(row);
                }
            }
        };
        search.oninput = () => {
            query = search.value;
            draw();
        };
        draw();
        return;
    }
    const graph = inspection.logic;
    if (!graph) {
        return;
    }
    toolbar.append(
        select(
            [
                ['both', labels.bothDirections],
                ['upstream', labels.upstream],
                ['downstream', labels.downstream],
            ],
            graph.direction,
            (direction) => post('logic-options', { value: { direction } })
        ),
        select(
            [1, 2, 3, 4, 5].map((depth) => [String(depth), labels.depth + ' ' + depth]),
            String(graph.depth),
            (depth) => post('logic-options', { value: { depth: Number(depth) } })
        ),
        button(labels.refresh, () => post('refresh'))
    );
    host.append(make('p', labels.logicHelp));
    const lookup = make('form');
    lookup.className = 'analysis-toolbar';
    const input = make('input');
    input.type = 'search';
    input.value = graphDraft?.id === inspection.id ? graphDraft.value : (graph.query ?? '');
    input.oninput = () => {
        graphDraft = { id: inspection.id, value: input.value };
    };
    input.placeholder = labels.searchObjects;
    input.setAttribute('aria-label', labels.searchObjects);
    lookup.append(
        input,
        button(labels.searchObjects, () => post('logic-search', { value: input.value }))
    );
    lookup.onsubmit = (event) => {
        event.preventDefault();
        post('logic-search', { value: input.value });
    };
    host.append(lookup);
    if (graph.query) {
        const matches = make('div');
        matches.className = 'analysis-toolbar';
        for (const node of graph.choices ?? []) {
            const choice = button(node.name + ' · ' + (displayType(node.type) || node.category), () =>
                post('logic-options', { value: { focus: node.id } })
            );
            choice.title = [node.label, node.category, node.source].filter(Boolean).join(' · ');
            matches.append(choice);
        }
        host.append(matches);
    }
    if (graph.stale) {
        const warning = make('p', labels.graphStale);
        warning.className = 'warning';
        host.append(warning);
    }
    if (graph.truncated) {
        const note = make('p', labels.graphTruncated);
        note.className = 'warning';
        host.append(note);
    }
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const focus = nodes.get(graph.focus);
    const center = make('article');
    center.className = 'logic-focus';
    center.append(
        make('h2', focus?.name ?? ''),
        make('p', [displayType(focus?.type ?? ''), focus?.label].filter(Boolean).join(' · ')),
        button(labels.openDefinition, () => post('source', { id: graph.focus }))
    );
    host.append(center);
    const columns = make('div');
    columns.className = 'logic-columns';
    host.append(columns);
    for (const [direction, title] of [
        ['upstream', labels.upstream],
        ['downstream', labels.downstream],
    ]) {
        const column = make('section');
        column.append(make('h2', title));
        const edges = graph.edges.filter((edge) =>
            direction === 'upstream' ? edge.to === graph.focus : edge.from === graph.focus
        );
        for (const edge of edges) {
            const node = nodes.get(direction === 'upstream' ? edge.from : edge.to)!;
            const card = make('article');
            card.className = 'logic-card' + (node.missing ? ' missing' : '');
            card.append(
                button(node.name + ' · ' + displayType(node.type), () =>
                    post('logic-options', { value: { focus: node.id } })
                ),
                make(
                    'p',
                    edge.key +
                        ' · ' +
                        (labels['relation_' + edge.kind] ?? edge.kind) +
                        (edge.inherited ? ' · ' + labels.inherited : '')
                ),
                button(edge.source, () => post('source', { id: edge.id }))
            );
            if (node.missing) {
                card.append(make('p', labels.missingTarget));
            }
            column.append(card);
        }
        if (!edges.length) {
            column.append(make('p', labels.noRelations));
        }
        columns.append(column);
    }
    const paths = make('details');
    paths.className = 'logic-paths';
    paths.open = graph.depth > 1;
    paths.append(make('summary', labels.allRelations + ' · ' + graph.edges.length));
    for (const edge of graph.edges) {
        const row = make('article');
        row.append(
            button(
                (nodes.get(edge.from)?.name ?? '') + ' → ' + (nodes.get(edge.to)?.name ?? '') + ' · ' + edge.key,
                () => post('source', { id: edge.id })
            )
        );
        paths.append(row);
    }
    host.append(paths);
}
