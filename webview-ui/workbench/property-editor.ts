import type { Inspection, WorkbenchLabels } from '../../src/context/workbench-protocol';

/** Property editing remains local until explicitly applied; the host validates its snapshot. */
export function renderProperties(
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
    const action = (text: string, handler: () => void) => {
        const button = make('button', text);
        button.type = 'button';
        button.onclick = handler;
        return button;
    };
    const filter = make('input');
    filter.type = 'search';
    filter.placeholder = labels.filter;
    filter.setAttribute('aria-label', labels.properties);
    const table = make('table');
    table.className = 'property-table';
    const body = make('tbody');
    table.append(body);
    host.append(filter, table);
    let active = false;
    const rows = inspection.properties.map((property) => {
        const row = make('tr'),
            key = make('th', property.key),
            value = make('td'),
            source = make('td');
        key.scope = 'row';
        const display = make('code', property.value);
        value.append(display);
        if (property.editId) {
            value.append(
                action(labels.editProperty, () => {
                    if (active) {
                        return;
                    }
                    active = true;
                    filter.disabled = true;
                    post('editing', { active: true });
                    const form = make('form');
                    form.className = 'property-form';
                    const input = make('input');
                    input.value = property.value;
                    if (property.minimum !== undefined) {
                        input.min = String(property.minimum);
                    }
                    if (property.maximum !== undefined) {
                        input.max = String(property.maximum);
                    }
                    const choices =
                        property.allowedValues ??
                        (/^(bool|boolean)$/i.test(property.valueType ?? '') ? ['yes', 'no'] : []);
                    if (choices.length) {
                        const options = make('datalist');
                        options.id = 'property-values-' + property.editId;
                        choices.forEach((choice) => {
                            const option = make('option');
                            option.value = choice;
                            options.append(option);
                        });
                        form.append(options);
                        input.setAttribute('list', options.id);
                    } else if (
                        ['int', 'integer', 'float', 'double', 'number'].includes(
                            property.valueType?.toLowerCase() ?? ''
                        ) ||
                        property.minimum !== undefined ||
                        property.maximum !== undefined
                    ) {
                        input.type = 'number';
                        input.step = /^(int|integer)$/i.test(property.valueType ?? '') ? '1' : 'any';
                    }
                    input.setAttribute('aria-label', property.key);
                    input.required = ['int', 'integer', 'float', 'double', 'number'].includes(
                        property.valueType?.toLowerCase() ?? ''
                    );
                    const target = make('p', labels.writeTo + ' ' + (property.editSource?.label ?? inspection.owner));
                    const preview = make('p');
                    preview.className = 'edit-preview';
                    const update = () => {
                        preview.textContent = property.value + ' → ' + input.value;
                    };
                    input.oninput = update;
                    update();
                    const close = () => {
                        active = false;
                        filter.disabled = false;
                        post('editing', { active: false });
                        form.remove();
                        display.hidden = false;
                    };
                    const apply = make('button', labels.apply);
                    apply.type = 'submit';
                    form.onsubmit = (event) => {
                        event.preventDefault();
                        if (form.reportValidity()) {
                            post('property-edit', { id: property.editId, value: input.value });
                        }
                    };
                    form.onkeydown = (event) => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            close();
                        }
                    };
                    const buttons = make('div');
                    buttons.className = 'controls';
                    buttons.append(apply, action(labels.cancel, close));
                    if (property.local) {
                        buttons.append(
                            action(labels.removeOverride, () => {
                                preview.textContent =
                                    labels.removeOverride + ': ' + property.key + ' · ' + labels.unsetValue;
                                form.onsubmit = (event) => {
                                    event.preventDefault();
                                    post('property-edit', { id: property.editId, value: null });
                                };
                                input.disabled = true;
                            })
                        );
                    }
                    form.append(target, input, preview, buttons);
                    display.hidden = true;
                    value.append(form);
                    input.focus();
                    if (input.type !== 'number') {
                        input.select();
                    }
                })
            );
        }
        const trace = make('details');
        trace.className = 'property-trace';
        trace.append(make('summary', (property.inherited ? '↳ ' : '') + property.source.label));
        for (const declaration of property.declarations ?? []) {
            const line = make('div');
            line.className = declaration.effective ? 'effective-declaration' : 'overridden-declaration';
            line.append(
                make('code', declaration.value),
                make('span', declaration.effective ? labels.effective : labels.overridden),
                action(declaration.source.label, () => post('source', { id: declaration.source.id })),
                make('small', declaration.via.join(' → '))
            );
            trace.append(line);
        }
        source.append(trace);
        row.append(key, value, source);
        body.append(row);
        return {
            row,
            search: [property.key, property.value, property.valueType, property.source.label].join(' ').toLowerCase(),
        };
    });
    filter.oninput = () => {
        const query = filter.value.trim().toLowerCase();
        rows.forEach(({ row, search }) => {
            row.hidden = !search.includes(query);
        });
    };
}
