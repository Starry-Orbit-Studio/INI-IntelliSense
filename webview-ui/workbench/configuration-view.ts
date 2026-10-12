import type {
    ConfigurationChange,
    ConfigurationField,
    ConfigurationModel,
} from '../../src/context/configuration-model';
import type { WorkbenchLabels } from '../../src/context/workbench-protocol';

interface Draft {
    model: ConfigurationModel;
    latest: ConfigurationModel;
    changes: Map<string, ConfigurationChange>;
    errors: Map<string, string>;
    group: string;
    search: string;
    pending: boolean;
    picking: boolean;
    error: string;
    status: string;
    paths?: { key: string; path: string; state: string }[];
}
const drafts = new Map<string, Draft>();
const clone = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let active:
    { state: Draft; draw: () => void; toolbar: () => void; post: (type: string, data?: object) => void } | undefined;
export const hasConfigurationDraft = () =>
    [...drafts.values()].some((state) => state.changes.size || state.pending || state.picking);

window.addEventListener('message', (event) => {
    const current = active,
        data = event.data;
    if (!current || data.snapshot !== current.state.model.id) {
        return;
    }
    const state = current.state;
    if (data.type === 'configuration-paths') {
        state.picking = false;
        state.paths = data.checks;
        current.post('configuration-draft', { snapshot: state.model.id, active: Boolean(state.changes.size) });
        current.draw();
    } else if (data.type === 'configuration-result') {
        state.pending = false;
        if (data.ok) {
            state.model = data.configuration;
            state.latest = data.configuration;
            state.changes.clear();
            state.errors.clear();
            state.status = 'saved';
            state.error = '';
        } else {
            state.error = String(data.error);
        }
        current.draw();
    } else if (data.type === 'configuration-picked') {
        state.picking = false;
        if (data.error) {
            state.error = String(data.error);
        }
        const field = state.model.fields.find((field) => field.key === data.key);
        if (!field || !Array.isArray(data.values)) {
            return;
        }
        if (data.values.length) {
            const next = clone(state.changes.get(field.key)?.value ?? field.value);
            let value: unknown;
            if (field.control === 'files') {
                value = { ...(next as object), [data.values[0]]: 'rules' };
            } else if (data.parts?.length) {
                const object = (next ?? {}) as Record<string, unknown>,
                    key = data.parts[0];
                const list =
                    field.control === 'entries' ||
                    ['modDirectories', 'rulesFiles', 'artFiles', 'extraMixes'].includes(key);
                object[key] = list
                    ? [...(Array.isArray(object[key]) ? (object[key] as string[]) : []), ...data.values]
                    : data.values[0];
                value = object;
            } else if (field.control === 'list') {
                value = [...(Array.isArray(next) ? next : []), ...data.values];
            } else {
                value = data.values[0];
            }
            state.changes.set(field.key, { key: field.key, value });
            state.status = '';
        }
        current.post('configuration-draft', { snapshot: state.model.id, active: Boolean(state.changes.size) });
        current.draw();
    }
    document.dispatchEvent(new Event('configuration-draft-changed'));
});

/** Typed editors retain drafts across state refreshes, and never accept project text as HTML. */
export function configurationView(
    host: HTMLElement,
    incoming: ConfigurationModel,
    labels: WorkbenchLabels,
    post: (type: string, data?: object) => void,
    groups?: string[],
    ownScope = true
): void {
    const visibleGroups = groups ?? [...new Set(incoming.fields.map((field) => field.group))];
    const identity =
        incoming.origin +
        ':' +
        incoming.scope +
        ':' +
        [...new Set(incoming.fields.map((field) => field.group))].join(',');
    let state = drafts.get(identity);
    if (!state) {
        state = {
            model: incoming,
            latest: incoming,
            changes: new Map(),
            errors: new Map(),
            group: visibleGroups[0],
            search: '',
            pending: false,
            picking: false,
            error: '',
            status: '',
        };
        drafts.set(identity, state);
    } else if (!state.changes.size && !state.pending && !state.picking) {
        state.model = incoming;
    }
    state.latest = incoming;
    const draft = state;
    if (!visibleGroups.includes(draft.group)) {
        draft.group = visibleGroups[0];
    }
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
    };
    const button = (text: string, run: () => void) => {
        const node = make('button', text);
        node.type = 'button';
        node.onclick = run;
        if (text === '×') {
            node.setAttribute('aria-label', labels.configRemove);
        }
        return node;
    };
    const title = (key: string) => labels['setting_' + key] ?? key;
    const summary = (value: unknown): string =>
        value === null || value === undefined || value === ''
            ? labels.configPath_unconfigured
            : Array.isArray(value)
              ? value.map(summary).join(' · ')
              : typeof value === 'object'
                ? Object.entries(value)
                      .map(([key, item]) => key + ': ' + summary(item))
                      .join(' / ')
                : typeof value === 'boolean'
                  ? value
                      ? labels.configEnabled
                      : labels.level_None
                  : String(value);
    const value = (field: ConfigurationField) => {
        const change = draft.changes.get(field.key);
        return change && !change.reset ? change.value : field.value;
    };
    const disabled = new WeakMap<HTMLElement, boolean>();
    const container = make('section');
    container.className = 'configuration-editor';
    host.append(container);
    const bar = make('div');
    bar.className = 'configuration-bar';
    const controls = make('div');
    controls.className = 'configuration-controls';
    const content = make('div');
    content.className = 'configuration-content';
    container.append(bar, controls, content);

    const apply = () => {
        if (!draft.changes.size || draft.errors.size || draft.pending) {
            return;
        }
        draft.pending = true;
        draft.error = '';
        drawBar();
        post('configuration-apply', { snapshot: draft.model.id, changes: [...draft.changes.values()] });
    };
    const stage = (field: ConfigurationField, next: unknown, redraw = false) => {
        if (draft.pending) {
            return;
        }
        if (equal(next, field.value)) {
            draft.changes.delete(field.key);
        } else {
            draft.changes.set(field.key, { key: field.key, value: next });
        }
        draft.errors.delete(field.key);
        draft.error = '';
        draft.status = '';
        draft.paths = undefined;
        post('configuration-draft', { snapshot: draft.model.id, active: Boolean(draft.changes.size) });
        document.dispatchEvent(new Event('configuration-draft-changed'));
        if (redraw) {
            draw();
        } else {
            drawBar();
        }
        if (field.immediate && draft.changes.size === 1) {
            apply();
        }
    };
    const pick = (field: ConfigurationField, parts: string[] = []) => {
        draft.picking = true;
        drawBar();
        document.dispatchEvent(new Event('configuration-draft-changed'));
        post('configuration-draft', { snapshot: draft.model.id, active: true });
        post('configuration-pick', { snapshot: draft.model.id, key: field.key, parts });
    };
    const drawBar = () => {
        bar.replaceChildren();
        if (ownScope) {
            const scope = make('select');
            scope.setAttribute('aria-label', labels.saveScope);
            for (const id of draft.model.scopes) {
                const option = make('option', labels['configScope_' + id]);
                option.value = id;
                scope.append(option);
            }
            scope.value = draft.model.scope;
            scope.disabled = Boolean(draft.changes.size || draft.pending || draft.picking);
            scope.onchange = () => post('configuration-scope', { value: scope.value });
            bar.append(scope);
        }
        const location = make('span', labels.configSaveTo + ' ' + draft.model.destination);
        location.className = 'configuration-destination';
        location.title = draft.model.destination;
        bar.append(location);
        const save = button(
            draft.pending
                ? labels.configApplying
                : labels.configApply + (draft.changes.size ? ' · ' + draft.changes.size : ''),
            apply
        );
        save.disabled = !draft.changes.size || Boolean(draft.errors.size) || draft.pending;
        const discard = button(labels.configDiscard, () => {
            draft.changes.clear();
            draft.errors.clear();
            draft.error = '';
            draft.status = '';
            draft.model = draft.latest;
            post('configuration-draft', { active: false });
            draw();
            document.dispatchEvent(new Event('configuration-draft-changed'));
        });
        discard.disabled = !draft.changes.size || draft.pending;
        if (draft.changes.size || draft.pending) {
            bar.append(save, discard);
        }
        const check = button(labels.configCheckPaths, () => {
            draft.picking = true;
            drawBar();
            document.dispatchEvent(new Event('configuration-draft-changed'));
            post('configuration-draft', { snapshot: draft.model.id, active: true });
            post('configuration-check-paths', { snapshot: draft.model.id });
        });
        check.disabled = Boolean(draft.changes.size) || draft.pending || draft.picking;
        bar.append(check);
        if (draft.status) {
            const status = make('span', labels.configSaved);
            status.setAttribute('role', 'status');
            bar.append(status);
        }
        for (const item of draft.paths ?? []) {
            const status = make(
                'p',
                (labels['setting_' + item.key] ?? labels['configRenderer_' + item.key] ?? item.key) +
                    ' · ' +
                    labels['configPath_' + item.state] +
                    ' · ' +
                    item.path
            );
            status.className = 'configuration-path-status';
            bar.append(status);
        }
        if (draft.error) {
            const error = make('p', draft.error);
            error.className = 'warning';
            error.setAttribute('role', 'alert');
            bar.append(error);
        }
        container
            .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
                '.configuration-content input,.configuration-content button,.configuration-content select,.configuration-content textarea'
            )
            .forEach((control) => {
                if (!disabled.has(control)) {
                    disabled.set(control, control.disabled);
                }
                control.disabled = draft.pending || draft.picking || disabled.get(control)!;
            });
    };
    const text = (name: string, initial: unknown, change: (next: string) => void) => {
        const input = make('input');
        input.type = 'text';
        input.value = String(initial ?? '');
        input.setAttribute('aria-label', name);
        input.oninput = () => change(input.value);
        return input;
    };
    const choice = (name: string, options: string[], initial: unknown, change: (next: string) => void) => {
        const input = make('select');
        input.setAttribute('aria-label', name);
        for (const id of [...new Set([...options, ...(initial ? [String(initial)] : [])])]) {
            const option = make('option', labels['configValue_' + id] ?? labels['configRule_' + id] ?? id);
            option.value = id;
            input.append(option);
        }
        input.value = String(initial ?? options[0]);
        input.onchange = () => change(input.value);
        return input;
    };
    const object = (field: ConfigurationField) => clone(value(field) ?? {}) as Record<string, unknown>;
    const list = (parent: HTMLElement, field: ConfigurationField, parts: string[] = [], picker = false) => {
        const get = (): string[] => {
            const current = parts.length ? object(field)[parts[0]] : value(field);
            return Array.isArray(current) ? ([...current] as string[]) : [];
        };
        const set = (next: string[]) => {
            if (parts.length) {
                const current = object(field);
                current[parts[0]] = next;
                stage(field, current, true);
            } else {
                stage(field, next, true);
            }
        };
        const rows = make('div');
        rows.className = 'configuration-list';
        parent.append(rows);
        get().forEach((item, index) => {
            const row = make('div');
            row.className = 'configuration-list-row';
            row.draggable = true;
            row.ondragstart = (event) => {
                event.dataTransfer?.setData(
                    'application/x-ra2-config-row',
                    JSON.stringify({ key: field.key, parts, index })
                );
            };
            row.ondragover = (event) => event.preventDefault();
            row.ondrop = (event) => {
                event.preventDefault();
                let data: { key: string; parts: string[]; index: number };
                try {
                    data = JSON.parse(event.dataTransfer?.getData('application/x-ra2-config-row') ?? '');
                } catch {
                    return;
                }
                const from = data.index;
                const items = get();
                if (
                    data.key === field.key &&
                    equal(data.parts, parts) &&
                    Number.isInteger(from) &&
                    from >= 0 &&
                    from < items.length &&
                    from !== index
                ) {
                    items.splice(index, 0, items.splice(from, 1)[0]);
                    set(items);
                }
            };
            const input = text(title(field.key) + ' ' + (parts[0] ?? '') + ' ' + (index + 1), item, (next) => {
                const items = get();
                items[index] = next;
                if (parts.length) {
                    const current = object(field);
                    current[parts[0]] = items;
                    stage(field, current);
                } else {
                    stage(field, items);
                }
            });
            const move = (offset: number) => {
                const items = get();
                [items[index], items[index + offset]] = [items[index + offset], items[index]];
                set(items);
            };
            const up = button('↑', () => move(-1));
            up.title = labels.configMoveUp;
            up.setAttribute('aria-label', labels.configMoveUp + ' ' + item);
            up.disabled = index === 0;
            const down = button('↓', () => move(1));
            down.title = labels.configMoveDown;
            down.setAttribute('aria-label', labels.configMoveDown + ' ' + item);
            down.disabled = index === get().length - 1;
            const remove = button('×', () => {
                const items = get();
                items.splice(index, 1);
                set(items);
            });
            remove.setAttribute('aria-label', labels.configRemove + ' ' + item);
            row.append(input, up, down, remove);
            rows.append(row);
        });
        const actions = make('div');
        actions.className = 'configuration-actions';
        actions.append(button(labels.configAdd, () => set([...get(), ''])));
        if (picker) {
            actions.append(button(labels.configBrowse, () => pick(field, parts)));
        }
        parent.append(actions);
    };
    const drawField = (field: ConfigurationField) => {
        const row = make('article');
        row.className = 'configuration-field control-' + field.control;
        row.dataset.setting = field.key;
        const head = make('div');
        head.className = 'configuration-field-head';
        const heading = make('h3', title(field.key));
        const origin = make('small', labels.configEffectiveFrom + ' ' + labels['configScope_' + field.source]);
        const reset = button(labels.configReset, () => {
            draft.changes.set(field.key, { key: field.key, reset: true });
            post('configuration-draft', { snapshot: draft.model.id, active: true });
            draw();
        });
        reset.disabled = !field.configured;
        head.append(heading, origin);
        if (field.configured) {
            head.append(reset);
        }
        row.append(head);
        if (field.effective !== undefined && !equal(field.effective, field.value)) {
            row.append(make('p', labels.configActualEffective + ' ' + summary(field.effective)));
        }
        const help = labels['help_' + field.key] ?? labels['configHelp_' + field.control];
        if (help && field.control !== 'toggle') {
            row.append(make('p', help));
        }
        if (draft.changes.get(field.key)?.reset) {
            row.append(make('p', labels.configWillInherit));
        }
        switch (field.control) {
            case 'toggle': {
                const input = make('input');
                input.type = 'checkbox';
                input.checked = value(field) === true;
                input.setAttribute('aria-label', title(field.key));
                input.onchange = () => stage(field, input.checked);
                row.append(input);
                break;
            }
            case 'choice':
                row.append(choice(title(field.key), field.choices ?? [], value(field), (next) => stage(field, next)));
                break;
            case 'number': {
                const input = make('input');
                input.type = 'number';
                input.value = value(field) === null || value(field) === undefined ? '' : String(value(field));
                input.setAttribute('aria-label', title(field.key));
                input.oninput = () => stage(field, input.value === '' ? null : Number(input.value));
                row.append(input);
                break;
            }
            case 'path':
            case 'text': {
                const inputs = make('div');
                inputs.className = 'configuration-path';
                inputs.append(text(title(field.key), value(field), (next) => stage(field, next)));
                if (field.picker) {
                    inputs.append(button(labels.configBrowse, () => pick(field)));
                }
                row.append(inputs);
                break;
            }
            case 'list':
                list(row, field, [], Boolean(field.picker));
                break;
            case 'entries':
            case 'categories': {
                const groups = object(field),
                    keys = [
                        ...new Set([
                            ...(field.control === 'entries'
                                ? ['rules', 'art', 'sound', 'eva', 'ai', 'ui', 'theme']
                                : []),
                            ...Object.keys(groups),
                        ]),
                    ];
                for (const category of keys) {
                    const section = make('details');
                    section.open =
                        (Array.isArray(groups[category]) && (groups[category] as unknown[]).length > 0) ||
                        ['rules', 'art', 'sound'].includes(category);
                    section.append(make('summary', labels['configValue_' + category] ?? category));
                    list(section, field, [category], field.control === 'entries');
                    row.append(section);
                }
                const add = text(labels.configCategoryName, '', () => undefined);
                row.append(
                    add,
                    button(labels.configAddCategory, () => {
                        const key = add.value.trim();
                        if (key && !['__proto__', 'constructor', 'prototype'].includes(key)) {
                            const current = object(field);
                            current[key] ??= [];
                            stage(field, current, true);
                        }
                    })
                );
                break;
            }
            case 'files':
            case 'bindings': {
                for (const [filename, category] of Object.entries(object(field))) {
                    const item = make('div');
                    item.className = 'configuration-mapping-row';
                    item.append(make('span', filename));
                    if (field.control === 'files') {
                        item.append(
                            choice(
                                filename,
                                ['rules', 'art', 'sound', 'eva', 'ai', 'ui', 'theme', 'ini'],
                                category,
                                (next) => {
                                    const current = object(field);
                                    current[filename] = next;
                                    stage(field, current);
                                }
                            )
                        );
                    } else {
                        item.append(
                            text(filename, category, (next) => {
                                const current = object(field);
                                current[filename] = next;
                                stage(field, current);
                            }),
                            button(labels.configBrowse, () => pick(field, [filename]))
                        );
                    }
                    item.append(
                        button('×', () => {
                            const current = object(field);
                            delete current[filename];
                            stage(field, current, true);
                        })
                    );
                    row.append(item);
                }
                if (field.control === 'files') {
                    row.append(button(labels.configChooseFile, () => pick(field)));
                } else {
                    const key = text(labels.configCategoryName, '', () => undefined);
                    row.append(
                        key,
                        button(labels.configAdd, () => {
                            if (key.value.trim()) {
                                const current = object(field);
                                current[key.value.trim()] = '';
                                stage(field, current, true);
                            }
                        })
                    );
                }
                break;
            }
            case 'renderer': {
                for (const key of [
                    'executable',
                    'mixDirectory',
                    'modDirectories',
                    'rulesFiles',
                    'artFiles',
                    'extraMixes',
                ]) {
                    const section = make('details');
                    section.open = ['executable', 'mixDirectory'].includes(key);
                    section.append(make('summary', labels['configRenderer_' + key]));
                    if (['executable', 'mixDirectory'].includes(key)) {
                        const input = text(labels['configRenderer_' + key], object(field)[key], (next) => {
                            const current = object(field);
                            current[key] = next;
                            stage(field, current);
                        });
                        section.append(
                            input,
                            button(labels.configBrowse, () => pick(field, [key]))
                        );
                    } else {
                        list(section, field, [key], true);
                    }
                    row.append(section);
                }
                break;
            }
            case 'exceptions': {
                const get = () =>
                    clone(Array.isArray(value(field)) ? value(field) : []) as {
                        files: string;
                        severity: Record<string, string>;
                    }[];
                get().forEach((exception, index) => {
                    const card = make('div');
                    card.className = 'configuration-exception';
                    card.append(
                        text(labels.configFilePattern, exception.files, (next) => {
                            const items = get();
                            items[index].files = next;
                            stage(field, items);
                        })
                    );
                    for (const [code, level] of Object.entries(exception.severity ?? {})) {
                        const item = make('div');
                        item.className = 'configuration-mapping-row';
                        item.append(
                            make('span', code),
                            choice(code, ['Error', 'Warning', 'Information', 'Hint', 'None'], level, (next) => {
                                const items = get();
                                items[index].severity[code] = next;
                                stage(field, items);
                            }),
                            button('×', () => {
                                const items = get();
                                delete items[index].severity[code];
                                stage(field, items, true);
                            })
                        );
                        card.append(item);
                    }
                    const rule = choice(labels.configChooseRule, field.choices ?? ['L001'], 'L001', () => undefined);
                    card.append(
                        rule,
                        button(labels.configAddRule, () => {
                            const items = get();
                            items[index].severity[rule.value] = 'Warning';
                            stage(field, items, true);
                        }),
                        button(labels.configRemove, () => {
                            const items = get();
                            items.splice(index, 1);
                            stage(field, items, true);
                        })
                    );
                    row.append(card);
                });
                row.append(
                    button(labels.configAddException, () =>
                        stage(field, [...get(), { files: '**/*.ini', severity: {} }], true)
                    )
                );
                break;
            }
            case 'advanced': {
                const details = make('details');
                details.append(make('summary', labels.configAdvanced));
                const input = make('textarea');
                input.rows = 8;
                input.value = JSON.stringify(value(field), null, 2);
                input.setAttribute('aria-label', title(field.key));
                const error = make('p');
                error.setAttribute('role', 'alert');
                input.oninput = () => {
                    try {
                        stage(field, JSON.parse(input.value));
                        error.textContent = '';
                    } catch {
                        draft.errors.set(field.key, labels.configInvalidJson);
                        error.textContent = labels.configInvalidJson;
                        drawBar();
                    }
                };
                details.append(input, error);
                row.append(details);
                break;
            }
        }
        heading.title = field.key;
        return row;
    };
    const draw = () => {
        controls.replaceChildren();
        content.replaceChildren();
        if (visibleGroups.length > 1) {
            const nav = make('nav');
            nav.className = 'configuration-groups';
            for (const group of visibleGroups) {
                const tab = button(labels['configGroup_' + group], () => {
                    draft.group = group;
                    draw();
                });
                tab.setAttribute('aria-pressed', String(draft.group === group));
                nav.append(tab);
            }
            controls.append(nav);
        }
        const search = make('input');
        search.type = 'search';
        search.placeholder = labels.configSearch;
        search.setAttribute('aria-label', labels.configSearch);
        search.value = draft.search;
        const drawContent = () => {
            content.replaceChildren();
            const terms = draft.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
            const fields = draft.model.fields.filter(
                (field) =>
                    visibleGroups.includes(field.group) &&
                    (terms.length
                        ? terms.every((term) => (title(field.key) + ' ' + field.key).toLowerCase().includes(term))
                        : field.group === draft.group)
            );
            if (fields.some((field) => field.immediate)) {
                content.append(make('p', labels.configHelp_toggle));
            }
            if (fields.some((field) => field.group === 'dictionary')) {
                const actions = make('div');
                actions.className = 'configuration-actions';
                actions.append(
                    button(labels.updateDictionary, () => post('dictionary-update')),
                    button(labels.configAdvanced, () => post('native-settings'))
                );
                content.append(actions);
            }
            fields.forEach((field) => content.append(drawField(field)));
            if (!fields.length) {
                content.append(make('p', labels.noResults));
            }
            drawBar();
        };
        search.oninput = () => {
            draft.search = search.value;
            drawContent();
        };
        controls.append(search);
        drawContent();
    };
    active = { state: draft, draw, toolbar: drawBar, post };
    draw();
}
