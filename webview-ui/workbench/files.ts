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
    getState(): { split?: boolean; preview?: boolean; splitRatio?: number } | undefined;
    setState(state: unknown): void;
};
const api = acquireVsCodeApi(),
    main = document.querySelector<HTMLElement>('#files')!;
let state: FileBrowserState | undefined,
    active = 0,
    split = api.getState()?.split ?? false,
    initialized = false,
    dragging = false,
    pressedForDrag = false,
    dragPane = -1,
    pendingState: unknown,
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
    const element = el('button');
    if (symbol) {
        element.append(el('span', 'control-icon', symbol));
    }
    element.append(el('span', 'control-label', l(key)));
    element.setAttribute('aria-label', l(key));
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
const persist = () => api.setState({ split, preview: showPreview, splitRatio });
const toolbar = el('header', 'toolbar'),
    panels = el('section', 'panes'),
    notice = el('div', 'notice'),
    info = el('footer', 'global-info'),
    statusText = el('span', 'status-text'),
    cancel = button('cancel', () => send('cancel')),
    dismiss = button('close', () => send('dismiss'));
notice.setAttribute('role', 'status');
notice.setAttribute('aria-live', 'polite');
info.append(statusText, notice, cancel, dismiss);
main.append(toolbar, panels, info);
let busyTimer: ReturnType<typeof setTimeout> | undefined;
const dragFeedback = el('div', 'drag-feedback');
dragFeedback.hidden = true;
document.body.append(dragFeedback);
function stopDrag() {
    dragging = false;
    pressedForDrag = false;
    dragFeedback.hidden = true;
    document
        .querySelectorAll('.drop-active,.drop-target')
        .forEach((node) => node.classList.remove('drop-active', 'drop-target'));
    if (pendingState) {
        const data = pendingState;
        pendingState = undefined;
        window.dispatchEvent(new MessageEvent('message', { data }));
    }
}
document.addEventListener('dragend', stopDrag);
document.addEventListener(
    'pointerdown',
    (event) => {
        const target = event.target as HTMLElement;
        if (
            event.button === 0 &&
            target.closest('.file-row') &&
            (target.closest('.file-label,.icon') || target.closest('.file-row.selected'))
        ) {
            pressedForDrag = true;
            dragPane = Number(target.closest<HTMLElement>('[data-pane]')?.dataset.pane ?? -1);
        }
    },
    true
);
document.addEventListener(
    'pointerup',
    () => {
        pressedForDrag = false;
        if (!dragging) {
            setTimeout(stopDrag, 0);
        }
    },
    true
);
document.addEventListener(
    'pointercancel',
    () => {
        pressedForDrag = false;
        if (!dragging) {
            stopDrag();
        }
    },
    true
);
window.addEventListener('blur', () => {
    clearTimeout(previewTimer);
});

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
    private edgeScroll = 0;
    private scrollFrame = 0;
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
        const clearDrop = () => {
            this.edgeScroll = 0;
            cancelAnimationFrame(this.scrollFrame);
            dragFeedback.hidden = true;
            this.root.classList.remove('drop-active');
            this.root.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
        };
        const scrollEdge = () => {
            this.scroll.scrollTop += this.edgeScroll;
            if (this.edgeScroll) {
                this.scrollFrame = requestAnimationFrame(scrollEdge);
            }
        };
        this.root.addEventListener('dragover', (event) => {
            const types = event.dataTransfer?.types ?? [];
            if (!types.includes('application/x-ra2-resources') && !types.includes('Files')) {
                return;
            }
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-token]');
            const row = target && this.row(target.dataset.token!);
            clearDrop();
            if (this.data?.readonly || !this.data || state?.busy || (row && !row.directory && !row.archive)) {
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'none';
                }
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const moving = types.includes('application/x-ra2-resources') && event.shiftKey;
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = moving ? 'move' : 'copy';
            }
            if (row) {
                target!.classList.add('drop-target');
            } else {
                this.root.classList.add('drop-active');
            }
            dragFeedback.textContent = l(moving ? 'dropMove' : 'dropCopy') + ' · ' + (row?.name ?? this.data.label);
            dragFeedback.style.left = Math.min(event.clientX + 16, Math.max(8, innerWidth - 300)) + 'px';
            dragFeedback.style.top = Math.min(event.clientY + 16, innerHeight - 40) + 'px';
            dragFeedback.hidden = false;
            const bounds = this.scroll.getBoundingClientRect();
            this.edgeScroll = event.clientY < bounds.top + 30 ? -12 : event.clientY > bounds.bottom - 30 ? 12 : 0;
            if (this.edgeScroll) {
                this.scrollFrame = requestAnimationFrame(scrollEdge);
            }
        });
        this.root.addEventListener('dragleave', (event) => {
            if (!this.root.contains(event.relatedTarget as Node)) {
                clearDrop();
            }
        });
        this.root.addEventListener('dragend', clearDrop);
        // Keep internal drags out of VS Code's outer Webview drag forwarding.
        this.root.addEventListener('drag', (event) => event.stopPropagation());
        this.root.addEventListener('drop', (event) => {
            void (async () => {
                event.preventDefault();
                clearDrop();
                event.stopPropagation();
                stopDrag();
                if (this.data?.readonly || !this.data || state?.busy) {
                    return;
                }
                setActive(index);
                const target = (event.target as HTMLElement).closest<HTMLElement>('[data-token]'),
                    row = target && this.row(target.dataset.token!),
                    destination = row && (row.directory || row.archive) ? row.token : undefined;
                if (row && !row.directory && !row.archive) {
                    return;
                }
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
                        send('import', { target: destination });
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
            })().catch((error) => {
                console.error('[File browser drop]', error);
                send('uploadFailed');
            });
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
    update(data: PaneState | undefined, force = false) {
        if (!force && this.data && this.data.location === data?.location && this.data.revision === data?.revision) {
            return;
        }
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
        if ((dragging || pressedForDrag) && dragPane === this.index) {
            return;
        }
        const rows = this.table.getRowModel().rows;
        this.space.style.height = this.virtual.getTotalSize() + 'px';
        const rendered = new Set<string>();
        const existing = new Map(
            Array.from(this.space.children, (child) => [(child as HTMLElement).dataset.token!, child as HTMLElement])
        );
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
            rendered.add(data.token);
            const signature = JSON.stringify([
                item.index,
                data.name,
                data.size,
                data.directory,
                data.archive,
                data.id,
                data.status,
                data.diff,
            ]);
            const retained = existing.get(data.token);
            if (retained?.dataset.signature === signature) {
                retained.classList.toggle('selected', !!this.selection[data.token]);
                retained.classList.toggle('focused', item.index === this.focusIndex && active === this.index);
                retained.setAttribute('aria-selected', String(!!this.selection[data.token]));
                retained.style.transform = `translateY(${item.start}px)`;
                continue;
            }
            retained?.remove();
            const row = el('div', 'file-row');
            row.dataset.signature = signature;
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
                event.stopPropagation();
                if (!this.selection[data.token]) {
                    this.selection = { [data.token]: true };
                    this.focusIndex = item.index;
                    this.anchor = item.index;
                    row.classList.add('selected');
                }
                dragging = true;
                clearTimeout(previewTimer);
                send('cancelPreview');
                this.dragTokens = this.tokens;
                event.dataTransfer?.setData('application/x-ra2-resources', JSON.stringify(this.dragTokens));
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'copyMove';
                    const badge = el('div', 'drag-badge', this.dragTokens.length + ' ' + l('selected'));
                    document.body.append(badge);
                    event.dataTransfer.setDragImage(badge, 12, 12);
                    setTimeout(() => badge.remove(), 0);
                }
            };
            this.space.append(row);
        }
        for (const [token, row] of existing) {
            if (!rendered.has(token)) {
                row.remove();
            }
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
        this.preview();
    }

    preview(explicit = false) {
        const selected = this.selectedRow;
        clearTimeout(previewTimer);
        send('cancelPreview');
        if (
            (showPreview || explicit) &&
            this.tokens.length === 1 &&
            selected &&
            !selected.directory &&
            !selected.archive
        ) {
            previewToken = selected.token;
            previewTimer = setTimeout(
                () => send('preview', { pane: this.index, token: selected.token, explicit }),
                explicit ? 0 : 180
            );
        } else {
            previewToken = '';
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
            this.preview();
        } else if (event.key === ' ') {
            event.preventDefault();
            this.choose(this.focusIndex, command, event.shiftKey);
        } else if (event.key === 'Escape') {
            this.selection = {};
            this.updateTable();
            this.preview();
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
        let dragged = false,
            lassoFrame = 0,
            lastPointer = event;
        clearTimeout(previewTimer);
        send('cancelPreview');
        if (originRow) {
            originRow.draggable = false;
        }
        const move = (current: PointerEvent) => {
            lastPointer = current;
            cancelAnimationFrame(lassoFrame);
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
            if (current.clientY < rectangle.top + 24 || current.clientY > rectangle.bottom - 24) {
                lassoFrame = requestAnimationFrame(() => move(lastPointer));
            }
        };
        const stop = () => {
            cancelAnimationFrame(lassoFrame);
            if (originRow) {
                originRow.draggable = true;
            }
            if (!dragged && !originRow) {
                this.selection = original;
                this.updateTable();
            }
            this.scroll.focus();
            this.lasso.hidden = true;
            this.preview();
            if (this.scroll.hasPointerCapture(event.pointerId)) {
                this.scroll.releasePointerCapture(event.pointerId);
            }
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
panels.append(panes[0].root, grip, panes[1].root);
let splitRatio = Math.min(75, Math.max(25, api.getState()?.splitRatio ?? 50));
applyLayout();
function applyLayout() {
    panes[0].root.style.flex = split ? `0 0 calc(${splitRatio}% - 2.5px)` : '1 1 0';
    panes[1].root.hidden = !split;
    grip.hidden = !split;
}
grip.onpointerdown = (event) => {
    grip.setPointerCapture(event.pointerId);
    const move = (current: PointerEvent) => {
        const rect = panels.getBoundingClientRect();
        splitRatio = Math.min(75, Math.max(25, ((current.clientX - rect.left) / rect.width) * 100));
        applyLayout();
    };
    const stop = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', stop);
        persist();
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
    } else if (type === 'preview') {
        panes[active].preview(true);
    } else if (['openTab', 'openBeside'].includes(type)) {
        send(type, {
            token: panes[active].selectedRow?.directory || panes[active].selectedRow?.archive ? selected[0] : undefined,
        });
    } else if (type === 'open' && selected[0]) {
        const row = panes[active].selectedRow;
        send(row?.directory || row?.archive ? 'navigate' : 'open', { token: selected[0] });
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
    toolbar.replaceChildren();
    for (const key of ['copy', 'cut', 'paste', 'import', 'export', 'undo']) {
        toolbar.append(button(key, () => action(key)));
    }
    toolbar.append(
        button('more', () => {
            const box = toolbar.querySelector('[data-label=more]')!.getBoundingClientRect();
            showMenu(box.left, box.bottom);
        }),
        el('span', 'spacer'),
        button('refresh', () => send('refresh')),
        button('openBeside', () => action('openBeside'), '⇥')
    );
    if (split) {
        toolbar.append(button('compare', () => send('compare')));
    }
    if (state?.compare) {
        toolbar.append(
            button('sync', () => action('sync')),
            button('clearCompare', () => send('clearCompare'))
        );
    }
    const splitButton = button(
        'split',
        () => {
            split = !split;
            if (!split) {
                setActive(0);
            }
            applyLayout();
            persist();
            renderToolbar();
        },
        '▥'
    );
    splitButton.setAttribute('aria-pressed', String(split));
    splitButton.classList.toggle('checked', split);
    const previewButton = button(
        'followPreview',
        () => {
            showPreview = !showPreview;
            persist();
            panes[active].preview();
            renderToolbar();
        },
        '◉'
    );
    previewButton.setAttribute('aria-pressed', String(showPreview));
    previewButton.classList.toggle('checked', showPreview);
    toolbar.append(splitButton, previewButton);
    updateButtons();
}
function showMenu(x: number, y: number) {
    document.querySelector('.context-menu')?.remove();
    const menu = el('div', 'context-menu');
    menu.style.left = Math.min(x, innerWidth - 200) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - 440)) + 'px';
    for (const key of [
        'open',
        'preview',
        'openTab',
        'openBeside',
        'diff',
        'copy',
        'cut',
        'paste',
        'export',
        'rename',
        'remove',
        'create',
        'import',
        'undo',
        'refresh',
    ].filter((key) => key !== 'diff' || panes[active].selectedRow?.diff)) {
        const control = button(key, () => {
            action(key);
            menu.remove();
        });
        control.disabled =
            (!['paste', 'create', 'openBeside', 'openTab', 'import', 'undo', 'refresh'].includes(key) &&
                !panes[active].tokens.length) ||
            !!state?.busy ||
            (!!state?.panes[active]?.readonly && ['paste', 'rename', 'remove', 'cut', 'create'].includes(key));
        if (key === 'preview') {
            control.disabled ||=
                panes[active].tokens.length !== 1 ||
                !!panes[active].selectedRow?.directory ||
                !!panes[active].selectedRow?.archive;
        }
        if (key === 'undo') {
            control.disabled ||= !state?.undo;
        }
        if (key === 'paste') {
            control.disabled ||= !state?.clipboard;
        }
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
        if (dragging || pressedForDrag) {
            pendingState = message;
            return;
        }
        if (!initialized) {
            split = api.getState()?.split ?? !!message.state.split;
            initialized = true;
        }
        state = message.state as FileBrowserState;
        panes.forEach((pane, index) => pane.update(state!.panes[index]));
        applyLayout();
        main.classList.toggle('comparing', !!state.compare);
        renderToolbar();
        clearTimeout(busyTimer);
        notice.textContent = state.message ?? '';
        notice.classList.toggle('error', !!state.message);
        cancel.textContent = l('cancel');
        dismiss.textContent = l('close');
        cancel.hidden = !state.busy;
        dismiss.hidden = !state.message;
        if (state.busy && !state.message) {
            busyTimer = setTimeout(() => {
                notice.textContent = l('working');
            }, 200);
        }
        statusText.textContent = state.compare
            ? Object.entries(state.compare.counts)
                  .map(([key, count]) => l(key) + ': ' + count)
                  .join(' · ')
            : state.panes[active]?.archive
              ? l('flat')
              : l('dragHint');
        if (state.clipboard) {
            statusText.textContent +=
                ' · ' + state.clipboard + ' ' + l('clipboard') + (state.cut ? ' (' + l('move') + ')' : '');
        }
        statusText.title = statusText.textContent ?? '';
        notice.title = notice.textContent ?? '';
    } else if (message?.type === 'classification' && state && Array.isArray(message.results)) {
        for (const result of message.results) {
            for (const pane of state.panes) {
                const row = pane?.rows.find((row) => row.token === result.token);
                if (row) {
                    row.archive = result.archive;
                }
            }
        }
        panes.forEach((pane, index) => pane.update(state!.panes[index], true));
    } else if (message?.type === 'clipboard' && state) {
        state.clipboard = message.count;
        state.cut = message.cut;
        updateButtons();
    } else if (message?.type === 'active' && message.active) {
        panes[active].preview();
    }
});
setActive(0);
send('ready');
