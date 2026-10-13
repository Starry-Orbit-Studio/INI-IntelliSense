export interface FileRow {
    token: string;
    name: string;
    size: number;
    directory: boolean;
    archive: boolean;
    id?: string;
    status?: string;
    diff?: boolean;
}
export interface PaneState {
    revision: number;
    location: string;
    label: string;
    parent: string;
    crumbs: { token: string; label: string }[];
    rows: FileRow[];
    readonly: boolean;
    archive: boolean;
}
export interface FileBrowserState {
    panes: (PaneState | undefined)[];
    labels: Record<string, string>;
    clipboard: number;
    cut: boolean;
    undo: boolean;
    busy: boolean;
    split?: boolean;
    message?: string;
    compare?: { counts: Record<string, number> };
}

export const browserLabelDefaults: Record<string, string> = {
    title: 'Files and MIX',
    openFolder: 'Open folder',
    openArchive: 'Open MIX',
    up: 'Parent folder',
    back: 'Back',
    forward: 'Forward',
    refresh: 'Refresh',
    search: 'Filter files…',
    name: 'Name',
    size: 'Size',
    type: 'Type',
    id: 'MIX ID',
    folder: 'Folder',
    archive: 'MIX archive',
    file: 'File',
    empty: 'This location is empty.',
    selectRoot: 'Open a folder or MIX to browse its contents.',
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    import: 'Import files',
    export: 'Extract to folder',
    remove: 'Delete',
    rename: 'Rename',
    create: 'New MIX',
    undo: 'Undo last operation',
    compare: 'Compare both locations',
    clearCompare: 'Clear comparison',
    differences: 'Differences only',
    sync: 'Copy selected differences to the other pane',
    open: 'Open',
    close: 'Close',
    readOnly: 'Read-only',
    flat: 'Folder imports into MIX use resource basenames; name / ID collisions are resolved before writing.',
    selected: 'selected',
    entries: 'items',
    clipboard: 'on clipboard',
    move: 'Move',
    duplicate: 'Replace',
    status: 'Comparison',
    'left-only': 'Only on left',
    'right-only': 'Only on right',
    different: 'Different content',
    identical: 'Identical',
    'type-mismatch': 'File / folder conflict',
    split: 'Dual pane',
    openBeside: 'Open beside',
    openTab: 'Open in new tab',
    followPreview: 'Follow selection in bottom preview',
    preview: 'Show in bottom preview',
    dropCopy: 'Copy to',
    dropMove: 'Move to',
    more: 'More actions',
    loading: 'Loading…',
    cancel: 'Cancel',
    working: 'Applying operation…',
    dragHint:
        'Drag between folders, MIX archives or editor groups to copy. Hold Shift to move. MIX files are copied whole; enter them to copy their contents.',
    previewHint: 'Select a file to preview. Double-click to open; double-click a MIX to enter it.',
    hashHint: 'Unknown names keep their original MIX ID. They are not renamed automatically.',
    diff: 'Open text diff',
};
