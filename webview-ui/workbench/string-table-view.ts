import type { Inspection, WorkbenchLabels } from '../../src/context/workbench-protocol';

/** A virtual list keeps large language files responsive; the detail preserves line breaks. */
export function stringTableView(
    host: HTMLElement,
    inspection: Inspection,
    labels: WorkbenchLabels,
    post: (type: string, data?: Record<string, unknown>) => void
): () => void {
    const entries = inspection.stringTable!.entries;
    const root = document.createElement('section');
    root.className = 'string-table';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = labels.stringSearch;
    search.setAttribute('aria-label', labels.stringSearch);
    const count = document.createElement('span');
    const tools = document.createElement('div');
    tools.className = 'string-tools';
    tools.append(search, count);
    const body = document.createElement('div');
    body.className = 'string-body';
    const list = document.createElement('div');
    list.className = 'string-list';
    list.tabIndex = 0;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', labels.stringEntries);
    const space = document.createElement('div');
    space.className = 'string-space';
    list.append(space);
    const detail = document.createElement('section');
    detail.className = 'string-detail';
    body.append(list, detail);
    root.append(tools, body);
    host.append(root);
    let filtered = entries.map((_, index) => index),
        selected = filtered[0];
    const rowHeight = 36;
    const select = (index: number) => {
        selected = index;
        detail.replaceChildren();
        const entry = entries[index];
        if (entry) {
            const heading = document.createElement('h2');
            heading.textContent = entry.label;
            const value = document.createElement('pre');
            value.textContent = entry.value;
            const actions = document.createElement('div');
            actions.className = 'string-tools';
            for (const [text, type] of [
                [labels.stringCopyLabel, 'string-copy-label'],
                [labels.stringCopyValue, 'string-copy-value'],
                [labels.stringReferences, 'string-uses'],
                ...(entry.line !== undefined ? [[labels.stringOpen, 'string-open']] : []),
            ]) {
                const button = document.createElement('button');
                button.textContent = text;
                button.onclick = () => post(type, { index });
                actions.append(button);
            }
            detail.append(heading, actions, value);
            if (entry.extraValue !== undefined) {
                const extra = document.createElement('pre');
                extra.textContent = labels.stringExtra + ': ' + entry.extraValue;
                detail.append(extra);
            }
        }
        render();
    };
    const render = () => {
        count.textContent = filtered.length + ' / ' + entries.length + ' ' + labels.stringEntries;
        space.style.height = filtered.length * rowHeight + 'px';
        space.replaceChildren();
        const start = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 3);
        const end = Math.min(filtered.length, start + Math.ceil(list.clientHeight / rowHeight) + 8);
        for (let row = start; row < end; row++) {
            const index = filtered[row],
                entry = entries[index];
            const control = document.createElement('div');
            control.className = 'string-row';
            control.id = 'string-entry-' + index;
            control.setAttribute('role', 'option');
            control.setAttribute('aria-selected', String(index === selected));
            control.setAttribute('aria-posinset', String(row + 1));
            control.setAttribute('aria-setsize', String(filtered.length));
            control.style.top = row * rowHeight + 'px';
            const name = document.createElement('strong'),
                text = document.createElement('span');
            name.textContent = entry.label;
            text.textContent = entry.value;
            control.append(name, text);
            control.onclick = () => {
                list.focus();
                select(index);
            };
            space.append(control);
        }
        list.setAttribute('aria-activedescendant', 'string-entry-' + selected);
    };
    search.oninput = () => {
        const query = search.value.toLowerCase();
        filtered = entries.flatMap((entry, index) =>
            (entry.label + '\n' + entry.value).toLowerCase().includes(query) ? [index] : []
        );
        list.scrollTop = 0;
        select(filtered[0]);
    };
    list.onscroll = render;
    list.onkeydown = (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const next = Math.max(
            0,
            Math.min(
                filtered.length - 1,
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? filtered.length - 1
                      : filtered.indexOf(selected) + (event.key === 'ArrowDown' ? 1 : -1)
            )
        );
        if (next * rowHeight < list.scrollTop) {
            list.scrollTop = next * rowHeight;
        }
        if ((next + 1) * rowHeight > list.scrollTop + list.clientHeight) {
            list.scrollTop = (next + 1) * rowHeight - list.clientHeight;
        }
        select(filtered[next]);
    };
    const observer = new ResizeObserver(render);
    observer.observe(list);
    select(selected);
    return () => observer.disconnect();
}
