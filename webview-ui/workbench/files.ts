import {
    createTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    functionalUpdate,
    SortingState,
    RowSelectionState,
} from '@tanstack/table-core';
import { Virtualizer, observeElementRect, observeElementOffset, elementScroll } from '@tanstack/virtual-core';
import type { FileBrowserState, FileRow, PaneState } from '../../src/mix/browser/protocol';
import './files.css';

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): { split?: boolean; preview?: boolean } | undefined;
    setState(state: unknown): void;
};
const api = acquireVsCodeApi(),
    main = document.querySelector<HTMLElement>('#files')!;
let state: FileBrowserState | undefined,
    active = 0,
    split = api.getState()?.split ?? true,
    showPreview = api.getState()?.preview ?? true,
    previewToken = '',
    previewTimer: ReturnType<typeof setTimeout> | undefined;
const l = (key: string) => state?.labels[key] ?? key;
const send = (type: string, extra: Record<string, unknown> = {}) => api.postMessage({ type, pane: active, ...extra });
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
};
const button = (key: string, action: () => void, symbol?: string) => {
    const element = el('button', '', symbol ? symbol + ' ' + l(key) : l(key));
    element.title = l(key);
    element.dataset.label = key;
    element.onclick = action;
    return element;
};
const size = (value: number) =>
    value < 1024
        ? value + ' B'
        : value < 1024 * 1024
          ? (value / 1024).toFixed(1) + ' KiB'
          : (value / 1024 / 1024).toFixed(1) + ' MiB';
const persist = () => api.setState({ split, preview: showPreview });
const toolbar = el('header', 'toolbar'),
    panels = el('section', 'panes'),
    notice = el('div', 'notice'),
    info = el('footer', 'global-info'),
    preview = el('aside', 'file-preview');
main.append(toolbar, notice, panels, info);

let panes: Pane[] = [];

class Pane {
    readonly root = el('section', 'pane');
    private readonly nav = el('div', 'navigation');
    private readonly crumbs = el('div', 'crumbs');
    private readonly actions = el('div', 'pane-actions');
    private readonly filter = el('input');
    private readonly columns = el('div', 'columns');
    private readonly scroll = el('div', 'file-scroll');
    private readonly space = el('div', 'row-space');
    private readonly footer = el('footer', 'pane-info');
    private readonly empty = el('div', 'empty');
    private readonly lasso = el('div', 'lasso');
    private anchor = 0;
    private focusIndex = 0;
    private sorting: SortingState = [{ id: 'name', desc: false }];
    private selection: RowSelectionState = {};
    private data?: PaneState;
    private readonly probed = new Set<string>();
    private diffOnly = false;
    private dragTokens: string[] = [];
    private table = createTable<FileRow>({
        data: [],
        columns: [
            {
                id: 'name',
                accessorKey: 'name',
                sortingFn: (a, b) =>
                    a.original.directory !== b.original.directory
                        ? a.original.directory
                            ? -1
                            : 1
                        : a.original.name.localeCompare(b.original.name, undefined, { numeric: true }),
            },
            { id: 'size', accessorKey: 'size' },
        ],
        state: { sorting: this.sorting, rowSelection: this.selection, globalFilter: '' },
        onStateChange: () => undefined,
        renderFallbackValue: '',
        getRowId: (row) => row.token,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: (updater) => {
            this.sorting = functionalUpdate(updater, this.sorting);
            this.updateTable();
        },
        globalFilterFn: (row) =>
            row.original.name.toLowerCase().includes(this.filter.value.toLowerCase()) ||
            (row.original.id ?? '').toLowerCase().includes(this.filter.value.toLowerCase()),
        enableRowSelection: true,
    });
    private virtual = new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count: 0,
        getScrollElement: () => this.scroll,
        estimateSize: () => 34,
        overscan: 8,
        observeElementRect,
        observeElementOffset,
        scrollToFn: elementScroll,
        onChange: () => this.renderRows(),
    });

    constructor(readonly index: number) {
        this.root.dataset.pane = String(index);
        this.scroll.tabIndex = 0;
        this.scroll.setAttribute('role', 'grid');
        this.scroll.setAttribute('aria-multiselectable', 'true');
        this.lasso.hidden = true;
        this.filter.type = 'search';
        this.filter.oninput = () => {
            this.updateTable();
            this.scroll.scrollTop = 0;
        };
        this.scroll.append(this.space, this.empty, this.lasso);
        this.root.append(this.nav, this.crumbs, this.actions, this.columns, this.scroll, this.footer);
        this.root.addEventListener('pointerdown', () => setActive(index));
        this.scroll.addEventListener('keydown', (event) => this.key(event));
        this.scroll.addEventListener('pointerdown', (event) => this.startLasso(event));
        this.root.addEventListener('dragover', (event) => {
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-token]'),
                row = target && this.row(target.dataset.token!);
            if ((row && !row.directory && !row.archive) || this.data?.readonly) {
                return;
            }
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = event.shiftKey ? 'move' : 'copy';
            }
            this.root.classList.add('drop-active');
        });
        this.root.addEventListener('dragleave', (event) => {
            if (!this.root.contains(event.relatedTarget as Node)) {
                this.root.classList.remove('drop-active');
            }
        });
        this.root.addEventListener('drop', async (event) => {
            event.preventDefault();
            this.root.classList.remove('drop-active');
            setActive(index);
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-token]'),
                row = target && this.row(target.dataset.token!),
                destination = row && (row.directory || row.archive) ? row.token : undefined;
            const payload = event.dataTransfer?.getData('application/x-ra2-resources');
            if (payload) {
                try {
                    const tokens: unknown = JSON.parse(payload);
                    if (Array.isArray(tokens) && tokens.every((token) => typeof token === 'string')) {
                        send('transfer', { tokens, target: destination, move: event.shiftKey });
                    }
                } catch {
                    /* Ignore foreign drag data. */
                }
            } else if (event.dataTransfer?.files.length) {
                const files: { file: File; name: string }[] = [],
                    directories: string[] = [];
                const collect = async (entry: FileSystemEntry, prefix = ''): Promise<void> => {
                    const name = prefix + entry.name;
                    if (entry.isFile) {
                        files.push({
                            name,
                            file: await new Promise<File>((resolve, reject) =>
                                (entry as FileSystemFileEntry).file(resolve, reject)
                            ),
                        });
                    } else {
                        directories.push(name);
                        const reader = (entry as FileSystemDirectoryEntry).createReader();
                        while (true) {
                            const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                                reader.readEntries(resolve, reject)
                            );
                            if (!entries.length) {
                                break;
                            }
                            for (const child of entries) {
                                await collect(child, name + '/');
                            }
                        }
                    }
                };
                const entries = Array.from(event.dataTransfer.items)
                    .map((item) => item.webkitGetAsEntry())
                    .filter((entry): entry is FileSystemEntry => !!entry);
                if (entries.length) {
                    for (const entry of entries) {
                        await collect(entry);
                    }
                } else {
                    files.push(...Array.from(event.dataTransfer.files).map((file) => ({ file, name: file.name })));
                }
                if (
                    files.length > 1024 ||
                    directories.length > 1024 ||
                    files.reduce((sum, item) => sum + item.file.size, 0) > 96 * 1024 * 1024
                ) {
                    send('import');
                    return;
                }
                const uploads = await Promise.all(
                    files.map(async ({ file, name }) => {
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        let binary = '';
                        for (let offset = 0; offset < bytes.length; offset += 32768) {
                            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                        }
                        return { name, content: btoa(binary) };
                    })
                );
                send('upload', { files: uploads, directories, target: destination });
            }
        });
        this.virtual._didMount();
        this.virtual._willUpdate();
    }

    private row(token: string): FileRow | undefined {
        return this.data?.rows.find((row) => row.token === token);
    }
    get tokens(): string[] {
        return this.table
            .getRowModel()
            .rows.filter((row) => this.selection[row.id])
            .map((row) => row.id);
    }
    get selectedRow(): FileRow | undefined {
        return this.row(this.tokens[0]);
    }
    update(data: PaneState | undefined) {
        const changed = this.data?.location !== data?.location;
        if (this.data?.revision !== data?.revision || changed) {
            this.probed.clear();
        }
        this.data = data;
        if (changed) {
            this.selection = {};
            this.anchor = 0;
            this.focusIndex = 0;
            this.filter.value = '';
            this.scroll.scrollTop = 0;
        } else {
            const ids = new Set(data?.rows.map((row) => row.token));
            this.selection = Object.fromEntries(Object.entries(this.selection).filter(([id]) => ids.has(id)));
        }
        this.nav.replaceChildren(
            button('back', () => send('back', { pane: this.index }), '←'),
            button('forward', () => send('forward', { pane: this.index }), '→'),
            button('up', () => data && send('navigate', { pane: this.index, token: data.parent }), '↑'),
            button('openFolder', () => send('pick', { pane: this.index, folder: true })),
            button('openArchive', () => send('pick', { pane: this.index, folder: false }))
        );
        this.crumbs.replaceChildren();
        for (const crumb of data?.crumbs ?? []) {
            const control = el('button', '', crumb.label);
            control.onclick = () => send('navigate', { pane: this.index, token: crumb.token });
            this.crumbs.append(control, el('span', '', '›'));
        }
        this.crumbs.title = data?.label ?? '';
        this.root.classList.toggle('archive-pane', !!data?.archive);
        this.filter.placeholder = l('search');
        this.filter.setAttribute('aria-label', l('search'));
        const toggle = button('differences', () => {
            this.diffOnly = !this.diffOnly;
            this.updateTable();
            toggle.classList.toggle('checked', this.diffOnly);
        });
        toggle.classList.toggle('checked', this.diffOnly);
        toggle.hidden = !state?.compare;
        this.actions.replaceChildren(this.filter, toggle);
        this.columns.replaceChildren();
        for (const key of ['name', 'size', 'type', 'status']) {
            const control = el('button', key, l(key));
            if (key === 'name' || key === 'size') {
                control.onclick = () => this.table.getColumn(key)?.toggleSorting();
                control.textContent += this.sorting[0]?.id === key ? (this.sorting[0].desc ? ' ↓' : ' ↑') : '';
            }
            this.columns.append(control);
        }
        this.empty.textContent = data ? l('empty') : l('selectRoot');
        this.updateTable();
        this.virtual._willUpdate();
    }

    private updateTable() {
        const data =
            this.data?.rows.filter((row) => !this.diffOnly || !state?.compare || row.status !== 'identical') ?? [];
        this.table.setOptions((previous) => ({
            ...previous,
            data,
            state: {
                ...previous.state,
                sorting: this.sorting,
                rowSelection: this.selection,
                globalFilter: this.filter.value,
            },
        }));
        this.virtual.setOptions({ ...this.virtual.options, count: this.table.getRowModel().rows.length });
        this.virtual._willUpdate();
        this.renderRows();
    }

    private renderRows() {
        const rows = this.table.getRowModel().rows;
        this.space.style.height = this.virtual.getTotalSize() + 'px';
        this.space.replaceChildren();
        this.empty.hidden = rows.length > 0;
        this.scroll.setAttribute('aria-rowcount', String(rows.length));
        const probes: string[] = [];
        for (const item of this.virtual.getVirtualItems()) {
            const data = rows[item.index]?.original;
            if (!data) {
                continue;
            }
            if (!data.directory && !this.probed.has(data.token) && /^0x[0-9a-f]{8}$/i.test(data.name)) {
                this.probed.add(data.token);
                probes.push(data.token);
            }
            const row = el('div', 'file-row');
            row.dataset.token = data.token;
            row.dataset.index = String(item.index);
            row.draggable = true;
            row.style.transform = `translateY(${item.start}px)`;
            row.classList.toggle('selected', !!this.selection[data.token]);
            row.classList.toggle('focused', item.index === this.focusIndex && active === this.index);
            row.setAttribute('role', 'row');
            row.setAttribute('aria-selected', String(!!this.selection[data.token]));
            row.setAttribute('aria-rowindex', String(item.index + 1));
            const name = el('span', 'name'),
                icon = el('span', 'icon', data.directory ? '▸' : data.archive ? '▣' : '·');
            name.append(icon, el('span', 'file-label', data.name));
            name.title = data.name + (data.id ? '\n' + data.id : '');
            row.append(
                name,
                el('span', 'size', data.directory ? '' : size(data.size)),
                el(
                    'span',
                    'type',
                    data.directory
                        ? l('folder')
                        : data.archive
                          ? 'MIX'
                          : data.name.includes('.')
                            ? data.name.split('.').at(-1)!.toUpperCase()
                            : (data.id ?? l('file'))
                ),
                el('span', 'status status-' + (data.status ?? ''), data.status ? l(data.status) : '')
            );
            row.onclick = (event) => {
                this.choose(item.index, event.ctrlKey || event.metaKey, event.shiftKey);
                this.scroll.focus();
            };
            row.ondblclick = () => {
                if (data.directory || data.archive) {
                    send('navigate', { pane: this.index, token: data.token });
                } else {
                    send(data.diff ? 'diff' : 'open', { pane: this.index, token: data.token });
                }
            };
            row.oncontextmenu = (event) => {
                event.preventDefault();
                if (!this.selection[data.token]) {
                    this.choose(item.index, false, false);
                }
                showMenu(event.clientX, event.clientY);
            };
            row.ondragstart = (event) => {
                if (!this.selection[data.token]) {
                    this.selection = { [data.token]: true };
                    this.focusIndex = item.index;
                    this.anchor = item.index;
                    row.classList.add('selected');
                }
                this.dragTokens = this.tokens;
                event.dataTransfer?.setData('application/x-ra2-resources', JSON.stringify(this.dragTokens));
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'copyMove';
                }
            };
            this.space.append(row);
        }
        const total = rows.reduce((sum, row) => sum + row.original.size, 0);
        this.footer.textContent =
            `${rows.length} ${l('entries')} · ${this.tokens.length} ${l('selected')} · ${size(total)}` +
            (this.data?.readonly ? ' · ' + l('readOnly') : '');
        if (probes.length) {
            api.postMessage({ type: 'probe', pane: this.index, tokens: probes });
        }
        updateButtons();
    }

    private choose(index: number, toggle: boolean, range: boolean) {
        const rows = this.table.getRowModel().rows,
            row = rows[index];
        if (!row) {
            return;
        }
        if (range) {
            if (!toggle) {
                this.selection = {};
            }
            for (let at = Math.min(this.anchor, index); at <= Math.max(this.anchor, index); at++) {
                this.selection[rows[at].id] = true;
            }
        } else {
            if (!toggle) {
                this.selection = {};
            }
            this.selection[row.id] = toggle ? !this.selection[row.id] : true;
            this.anchor = index;
        }
        this.focusIndex = index;
        this.updateTable();
        const selected = this.selectedRow;
        clearTimeout(previewTimer);
        if (showPreview && this.tokens.length === 1 && selected && !selected.directory && !selected.archive) {
            previewToken = selected.token;
            preview.replaceChildren(el('p', '', l('loading')));
            previewTimer = setTimeout(() => send('preview', { pane: this.index, token: selected.token }), 180);
        } else {
            previewToken = '';
            preview.replaceChildren(el('p', '', l('previewHint')));
        }
    }

    private key(event: KeyboardEvent) {
        const count = this.table.getRowModel().rows.length,
            command = event.ctrlKey || event.metaKey;
        if (
            event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Home' ||
            event.key === 'End' ||
            event.key === 'PageDown' ||
            event.key === 'PageUp'
        ) {
            event.preventDefault();
            const delta = event.key.includes('Page') ? Math.max(1, Math.floor(this.scroll.clientHeight / 34)) : 1;
            const index =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? count - 1
                      : Math.min(
                            count - 1,
                            Math.max(0, this.focusIndex + (event.key.includes('Down') ? delta : -delta))
                        );
            if (command && !event.shiftKey) {
                this.focusIndex = index;
                this.renderRows();
            } else {
                this.choose(index, command, event.shiftKey);
            }
            this.virtual.scrollToIndex(index, { align: 'auto' });
        } else if (command && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            this.selection = Object.fromEntries(this.table.getRowModel().rows.map((row) => [row.id, true]));
            this.updateTable();
        } else if (event.key === ' ') {
            event.preventDefault();
            this.choose(this.focusIndex, command, event.shiftKey);
        } else if (event.key === 'Escape') {
            this.selection = {};
            this.updateTable();
        } else if (event.key === 'Enter' && this.selectedRow) {
            event.preventDefault();
            const row = this.selectedRow;
            send(row.directory || row.archive ? 'navigate' : 'open', { token: row.token });
        }
    }

    private startLasso(event: PointerEvent) {
        const target = event.target as HTMLElement,
            originRow = target.closest<HTMLElement>('.file-row');
        if (
            event.button !== 0 ||
            target.closest('.file-label,.icon') ||
            (originRow && this.selection[originRow.dataset.token!])
        ) {
            return;
        }
        const rectangle = this.scroll.getBoundingClientRect(),
            startX = event.clientX - rectangle.left,
            startY = event.clientY - rectangle.top + this.scroll.scrollTop;
        const original = event.ctrlKey || event.metaKey ? { ...this.selection } : {};
        let dragged = false;
        if (originRow) {
            originRow.draggable = false;
        }
        event.preventDefault();
        this.scroll.setPointerCapture(event.pointerId);
        const move = (current: PointerEvent) => {
            if (!dragged && Math.abs(current.clientX - event.clientX) + Math.abs(current.clientY - event.clientY) < 4) {
                return;
            }
            if (!dragged) {
                this.scroll.setPointerCapture(event.pointerId);
                this.lasso.hidden = false;
                dragged = true;
            }
            if (current.clientY < rectangle.top + 24) {
                this.scroll.scrollTop -= 24;
            } else if (current.clientY > rectangle.bottom - 24) {
                this.scroll.scrollTop += 24;
            }
            const x = current.clientX - rectangle.left,
                y = current.clientY - rectangle.top + this.scroll.scrollTop;
            const top = Math.min(startY, y),
                bottom = Math.max(startY, y);
            this.lasso.style.cssText = `left:${Math.min(startX, x)}px;top:${top}px;width:${Math.abs(x - startX)}px;height:${bottom - top}px;`;
            this.selection = { ...original };
            const rows = this.table.getRowModel().rows;
            for (
                let index = Math.max(0, Math.floor(top / 34));
                index <= Math.min(rows.length - 1, Math.floor(bottom / 34));
                index++
            ) {
                this.selection[rows[index].id] = true;
            }
            this.updateTable();
        };
        const stop = () => {
            if (originRow) {
                originRow.draggable = true;
            }
            if (!dragged && originRow) {
                this.choose(Number(originRow.dataset.index), event.ctrlKey || event.metaKey, event.shiftKey);
            } else if (!dragged) {
                this.selection = original;
                this.updateTable();
            }
            this.scroll.focus();
            this.lasso.hidden = true;
            this.scroll.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', stop);
            document.removeEventListener('pointercancel', stop);
        };
        this.scroll.addEventListener('pointermove', move);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
    }
}

panes.push(new Pane(0), new Pane(1));
const grip = el('div', 'split-grip');
grip.title = l('split');
panels.append(panes[0].root, grip, panes[1].root, preview);
let splitRatio = 50;
grip.onpointerdown = (event) => {
    grip.setPointerCapture(event.pointerId);
    const move = (current: PointerEvent) => {
        const rect = panels.getBoundingClientRect();
        splitRatio = Math.min(
            75,
            Math.max(25, ((current.clientX - rect.left) / (rect.width - (showPreview ? preview.offsetWidth : 0))) * 100)
        );
        panes[0].root.style.flexBasis = splitRatio + '%';
    };
    const stop = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', stop);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
};
function setActive(index: number) {
    active = index;
    panes.forEach((pane, at) => pane.root.classList.toggle('active', at === index));
    updateButtons();
}
function action(type: string) {
    if (state?.panes[active]?.readonly && ['cut', 'paste', 'import', 'create', 'remove', 'rename'].includes(type)) {
        return;
    }
    const selected = panes[active].tokens;
    if (
        (['copy', 'cut', 'remove', 'export', 'sync'].includes(type) && !selected.length) ||
        (type === 'rename' && selected.length !== 1)
    ) {
        return;
    }
    if (type === 'copy' || type === 'cut') {
        send('clipboard', { tokens: selected, cut: type === 'cut' });
    } else if (type === 'open' && selected[0]) {
        send('open', { token: selected[0] });
    } else {
        send(type, { tokens: selected });
    }
}
function updateButtons() {
    const count = panes[active]?.tokens.length ?? 0,
        root = state?.panes[active],
        readonly = !!root?.readonly;
    toolbar.querySelectorAll<HTMLButtonElement>('button').forEach((control) => {
        const key = control.dataset.label!;
        control.disabled =
            (!!state?.busy && key !== 'cancel') ||
            (['copy', 'cut', 'export', 'remove', 'rename', 'sync'].includes(key) && count === 0) ||
            (key === 'rename' && count !== 1) ||
            (['paste', 'import', 'create', 'remove', 'cut', 'rename'].includes(key) && (!root || readonly)) ||
            (key === 'paste' && !state?.clipboard) ||
            (key === 'undo' && !state?.undo) ||
            (key === 'compare' && (!state?.panes[0] || !state?.panes[1])) ||
            (key === 'sync' && !state?.compare);
    });
}
function renderToolbar() {
    toolbar.replaceChildren(el('strong', '', l('title')));
    for (const key of ['copy', 'cut', 'paste', 'import', 'export', 'rename', 'remove', 'create', 'undo']) {
        toolbar.append(button(key, () => action(key)));
    }
    toolbar.append(
        el('span', 'spacer'),
        button('refresh', () => send('refresh')),
        button('compare', () => send('compare'))
    );
    if (state?.compare) {
        toolbar.append(
            button('sync', () => action('sync')),
            button('clearCompare', () => send('clearCompare'))
        );
    }
    toolbar.append(
        button('split', () => {
            split = !split;
            if (!split) {
                setActive(0);
            }
            panes[1].root.hidden = !split;
            grip.hidden = !split;
            persist();
        }),
        button('preview', () => {
            showPreview = !showPreview;
            preview.hidden = !showPreview;
            persist();
        })
    );
    if (state?.busy) {
        toolbar.append(button('cancel', () => send('cancel')));
    }
    updateButtons();
}
function showMenu(x: number, y: number) {
    document.querySelector('.context-menu')?.remove();
    const menu = el('div', 'context-menu');
    menu.style.left = Math.min(x, innerWidth - 200) + 'px';
    menu.style.top = Math.min(y, innerHeight - 240) + 'px';
    for (const key of ['open', 'diff', 'copy', 'cut', 'paste', 'export', 'rename', 'remove'].filter(
        (key) => key !== 'diff' || panes[active].selectedRow?.diff
    )) {
        const control = button(key, () => {
            action(key);
            menu.remove();
        });
        control.disabled = key !== 'paste' && !panes[active].tokens.length;
        menu.append(control);
    }
    document.body.append(menu);
    setTimeout(
        () =>
            document.addEventListener(
                'pointerdown',
                (event) => {
                    if (!menu.contains(event.target as Node)) {
                        menu.remove();
                    }
                },
                { once: true }
            ),
        0
    );
}
document.addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).matches('input,textarea') || (event.target as HTMLElement).isContentEditable) {
        return;
    }
    const command = event.ctrlKey || event.metaKey,
        key = event.key.toLowerCase();
    let type: string | undefined;
    if (command) {
        type = ({ c: 'copy', x: 'cut', v: 'paste', z: 'undo' } as Record<string, string>)[key];
    } else if (key === 'delete') {
        type = 'remove';
    } else if (key === 'f2') {
        type = 'rename';
    } else if (key === 'f5') {
        type = 'refresh';
    }
    if (event.altKey && key === 'arrowup') {
        event.preventDefault();
        const root = state?.panes[active];
        if (root) {
            send('navigate', { token: root.parent });
        }
    } else if (event.altKey && ['arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        send(key === 'arrowleft' ? 'back' : 'forward');
    } else if (type && !state?.busy) {
        event.preventDefault();
        action(type);
    }
});
window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'state') {
        state = message.state as FileBrowserState;
        panes.forEach((pane, index) => pane.update(state!.panes[index]));
        panes[1].root.hidden = !split;
        grip.hidden = !split;
        preview.hidden = !showPreview;
        main.classList.toggle('comparing', !!state.compare);
        renderToolbar();
        notice.textContent = state.message ?? (state.busy ? l('working') : '');
        notice.hidden = !notice.textContent;
        notice.classList.toggle('error', !!state.message);
        info.textContent = state.compare
            ? Object.entries(state.compare.counts)
                  .map(([key, count]) => l(key) + ': ' + count)
                  .join(' · ')
            : state.panes[active]?.archive
              ? l('flat')
              : l('dragHint');
        if (state.clipboard) {
            info.textContent +=
                ' · ' + state.clipboard + ' ' + l('clipboard') + (state.cut ? ' (' + l('move') + ')' : '');
        }
        if (!preview.childElementCount) {
            preview.append(el('p', '', l('previewHint')));
        }
    } else if (message?.type === 'classification' && state && Array.isArray(message.results)) {
        for (const result of message.results) {
            for (const pane of state.panes) {
                const row = pane?.rows.find((row) => row.token === result.token);
                if (row) {
                    row.archive = result.archive;
                }
            }
        }
        panes.forEach((pane, index) => pane.update(state!.panes[index]));
    } else if (message?.type === 'clipboard' && state) {
        state.clipboard = message.count;
        state.cut = message.cut;
        updateButtons();
    } else if (message?.type === 'preview' && message.token === previewToken) {
        const heading = el('header', ''),
            open = button('open', () => send('open', { token: message.token }));
        heading.append(el('strong', '', message.name), open);
        preview.replaceChildren(heading);
        if (message.image) {
            const image = el('img');
            image.src = message.image;
            image.alt = message.name;
            preview.append(image);
        }
        if (message.audio) {
            const audio = el('audio');
            audio.src = message.audio;
            audio.controls = true;
            audio.preload = 'metadata';
            preview.append(audio);
        }
        if (message.text) {
            preview.append(el('pre', '', message.text));
        }
        if (message.hint) {
            preview.append(el('p', '', message.hint));
        }
    }
});
setActive(0);
send('ready');
