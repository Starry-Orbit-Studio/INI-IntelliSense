import type { Inspection, ObjectRow, WorkbenchLabels } from '../../src/context/workbench-protocol';

export interface CatalogPreferences {
    query?: string;
    category?: string;
    type?: string;
    favorites?: string[];
    onlyFavorites?: boolean;
}

/** Paginated DOM and explicit change previews keep large object collections responsive. */
export function objectBrowser(
    host: HTMLElement,
    inspection: Inspection,
    labels: WorkbenchLabels,
    post: (type: string, data?: object) => void,
    preferences: CatalogPreferences,
    save: (preferences: CatalogPreferences) => void
): () => void {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
    };
    const button = (label: string, handler: () => void) => {
        const result = make('button', label);
        result.type = 'button';
        result.onclick = handler;
        return result;
    };
    const select = (values: string[], label: string) => {
        const result = make('select');
        result.setAttribute('aria-label', label);
        values.forEach((value) => {
            const option = make('option', value || label);
            option.value = value;
            result.append(option);
        });
        return result;
    };
    const objects = inspection.objects ?? [],
        columns = inspection.objectColumns ?? [];
    const selected = new Set<string>(),
        favorites = new Set(
            (Array.isArray(preferences.favorites) ? preferences.favorites : []).filter(
                (value) => typeof value === 'string'
            )
        );
    const identity = (row: ObjectRow) => row.category + ':' + row.name.toLowerCase();
    const bar = make('div');
    bar.className = 'catalog-toolbar';
    const query = make('input');
    query.type = 'search';
    query.placeholder = labels.searchObjects;
    query.setAttribute('aria-label', labels.searchObjects);
    query.value = typeof preferences.query === 'string' ? preferences.query : '';
    const category = select(['', ...new Set(objects.map((row) => row.category))].sort(), labels.allCategories);
    const type = select(['', ...new Set(objects.map((row) => row.type))].sort(), labels.allTypes);
    category.value = preferences.category ?? '';
    type.value = preferences.type ?? '';
    const star = make('input');
    star.type = 'checkbox';
    star.checked = preferences.onlyFavorites === true;
    const starLabel = make('label', labels.favorites);
    starLabel.prepend(star);
    const count = make('span');
    count.setAttribute('aria-live', 'polite');
    const compare = button(labels.compareObjects, () => post('compare-objects', { ids: [...selected] }));
    const batch = button(labels.batchEdit, () => {
        form.hidden = !form.hidden;
        invalidatePlan();
    });
    const refresh = button(labels.refresh, () => post('refresh'));
    bar.append(query, category, type, starLabel, count, compare, batch, refresh);
    host.append(bar);
    const form = make('form');
    form.className = 'batch-form';
    form.hidden = true;
    const key = make('input');
    key.placeholder = labels.propertyKey;
    key.setAttribute('aria-label', labels.propertyKey);
    const operation = select(['set', 'add', 'percent'], labels.operation);
    Array.from(operation.options).forEach((option) => {
        option.textContent = labels['batch_' + option.value];
    });
    const value = make('input');
    value.setAttribute('aria-label', labels.newValue);
    value.placeholder = labels.newValue;
    const prepare = make('button', labels.previewChanges);
    prepare.type = 'submit';
    const plan = make('div');
    plan.className = 'change-preview';
    let request = 0;
    const invalidatePlan = () => {
        request++;
        plan.replaceChildren();
        post('editing', { active: false });
    };
    [key, operation, value].forEach((input) => input.addEventListener('input', invalidatePlan));
    form.append(key, operation, value, prepare, make('p', labels.batchHelp), plan);
    form.onsubmit = (event) => {
        event.preventDefault();
        if (selected.size && key.value.trim()) {
            plan.replaceChildren(make('p', labels.loading));
            post('batch-plan', {
                ids: [...selected],
                key: key.value.trim(),
                value: value.value,
                operation: operation.value,
                request: ++request,
            });
        }
    };
    host.append(form);
    const comparison = make('section');
    comparison.className = 'object-comparison';
    comparison.hidden = true;
    host.append(comparison);
    const scroll = make('div');
    scroll.className = 'catalog-scroll';
    const table = make('table');
    table.className = 'catalog-table';
    const header = make('thead'),
        headings = make('tr'),
        body = make('tbody');
    const allCell = make('th'),
        all = make('input');
    all.type = 'checkbox';
    all.setAttribute('aria-label', labels.selectPage);
    allCell.append(all);
    headings.append(allCell, make('th', '★'));
    const sortFields = ['name', 'type', 'category', ...columns];
    let sorting = 'name',
        descending = false,
        page = 0;
    for (const field of sortFields) {
        const cell = make('th');
        cell.append(
            button(labels['column_' + field] ?? field, () => {
                descending = sorting === field ? !descending : false;
                sorting = field;
                draw();
            })
        );
        headings.append(cell);
    }
    headings.append(make('th', labels.source));
    header.append(headings);
    table.append(header, body);
    scroll.append(table);
    host.append(scroll);
    const pagination = make('div');
    pagination.className = 'controls';
    const previous = button('‹', () => {
            page--;
            draw();
        }),
        next = button('›', () => {
            page++;
            draw();
        }),
        pageLabel = make('span');
    previous.setAttribute('aria-label', labels.previous);
    next.setAttribute('aria-label', labels.nextPage);
    pagination.append(
        previous,
        pageLabel,
        next,
        button(labels.clearSelection, () => {
            selected.clear();
            invalidatePlan();
            draw();
        })
    );
    host.append(pagination);
    let visible: ObjectRow[] = [];
    const changed = () => {
        compare.disabled = selected.size < 2 || selected.size > 8;
        batch.disabled = !selected.size || selected.size > 1000;
        count.textContent = objects.length + ' · ' + labels.selected + ' ' + selected.size;
        all.checked = visible.length > 0 && visible.every((row) => selected.has(row.id));
        all.indeterminate = !all.checked && visible.some((row) => selected.has(row.id));
    };
    const draw = () => {
        const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const rows = objects.filter(
            (row) =>
                (!category.value || row.category === category.value) &&
                (!type.value || row.type === type.value) &&
                (!star.checked || favorites.has(identity(row))) &&
                terms.every((term) =>
                    [row.name, row.label, row.source, row.type].join(' ').toLowerCase().includes(term)
                )
        );
        const get = (row: ObjectRow) =>
            sorting === 'name'
                ? row.name
                : sorting === 'type'
                  ? row.type
                  : sorting === 'category'
                    ? row.category
                    : (row.values[sorting] ?? '');
        rows.sort((a, b) => {
            const left = get(a),
                right = get(b);
            const numeric =
                left.trim() && right.trim() && Number.isFinite(Number(left)) && Number.isFinite(Number(right));
            const result = numeric
                ? Number(left) - Number(right)
                : left.localeCompare(right, undefined, { numeric: true });
            return (descending ? -result : result) || a.name.localeCompare(b.name);
        });
        const pages = Math.max(1, Math.ceil(rows.length / 100));
        page = Math.max(0, Math.min(pages - 1, page));
        visible = rows.slice(page * 100, (page + 1) * 100);
        body.replaceChildren();
        for (const row of visible) {
            const tr = make('tr'),
                selection = make('input'),
                selectionCell = make('td'),
                favoriteCell = make('td');
            selection.type = 'checkbox';
            selection.checked = selected.has(row.id);
            selection.setAttribute('aria-label', row.name);
            selection.onchange = () => {
                selection.checked ? selected.add(row.id) : selected.delete(row.id);
                invalidatePlan();
                changed();
            };
            selectionCell.append(selection);
            const favorite = button(favorites.has(identity(row)) ? '★' : '☆', () => {
                favorites.has(identity(row)) ? favorites.delete(identity(row)) : favorites.add(identity(row));
                draw();
            });
            favorite.setAttribute('aria-label', labels.favorites + ' ' + row.name);
            favoriteCell.append(favorite);
            const name = make('td');
            name.append(
                button(row.name, () => post('inspect-object', { id: row.id })),
                make('small', row.label)
            );
            tr.append(selectionCell, favoriteCell, name, make('td', row.type), make('td', row.category));
            columns.forEach((column) => tr.append(make('td', row.values[column])));
            const source = make('td');
            source.append(button(row.source, () => post('source', { id: row.id })));
            if (row.definitions > 1) {
                source.append(make('small', labels.definitions + ' ' + row.definitions));
            }
            tr.append(source);
            body.append(tr);
        }
        previous.disabled = page === 0;
        next.disabled = page >= pages - 1;
        pageLabel.textContent = page + 1 + ' / ' + pages + ' · ' + rows.length;
        changed();
        save({
            query: query.value,
            type: type.value,
            category: category.value,
            favorites: [...favorites],
            onlyFavorites: star.checked,
        });
    };
    all.onchange = () => {
        visible.forEach((row) => (all.checked ? selected.add(row.id) : selected.delete(row.id)));
        invalidatePlan();
        draw();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    query.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            page = 0;
            draw();
        }, 100);
    };
    [category, type, star].forEach((input) => {
        input.onchange = () => {
            page = 0;
            draw();
        };
    });
    const receive = (event: MessageEvent) => {
        const message = event.data;
        if (message.inspection !== inspection.id) {
            return;
        }
        if (message.type === 'batch-preview') {
            if (message.request !== request) {
                return;
            }
            plan.replaceChildren(make('h3', labels.previewChanges));
            const changes = make('table');
            for (const row of message.rows as { name: string; before: string; after: string; source: string }[]) {
                const tr = make('tr');
                tr.append(
                    make('th', row.name),
                    make('td', row.before),
                    make('td', '→ ' + row.after),
                    make('td', row.source)
                );
                changes.append(tr);
            }
            plan.append(
                changes,
                button(labels.apply, () => post('batch-apply', { id: message.id })),
                button(labels.cancel, () => {
                    invalidatePlan();
                })
            );
        } else if (message.type === 'object-comparison') {
            comparison.hidden = false;
            comparison.replaceChildren(make('h3', labels.compareObjects));
            const differences = make('input');
            differences.type = 'checkbox';
            differences.checked = true;
            const label = make('label', labels.onlyDifferences);
            label.prepend(differences);
            const grid = make('table'),
                head = make('tr');
            head.append(make('th', labels.propertyKey));
            (message.names as string[]).forEach((name) => head.append(make('th', name)));
            grid.append(head);
            const rows = (
                message.rows as { key: string; values: { value: string; source: string; inherited: boolean }[] }[]
            ).map((row) => {
                const tr = make('tr');
                tr.append(make('th', row.key));
                row.values.forEach((value) => {
                    const cell = make('td', (value.inherited ? '↳ ' : '') + value.value);
                    cell.title = value.source;
                    tr.append(cell);
                });
                grid.append(tr);
                return { tr, same: new Set(row.values.map((value) => value.value)).size <= 1 };
            });
            const filter = () =>
                rows.forEach(({ tr, same }) => {
                    tr.hidden = differences.checked && same;
                });
            differences.onchange = filter;
            filter();
            comparison.append(
                label,
                button(labels.close, () => {
                    comparison.hidden = true;
                }),
                grid
            );
            comparison.scrollIntoView({ block: 'nearest' });
        }
    };
    window.addEventListener('message', receive);
    draw();
    return () => {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
    };
}
