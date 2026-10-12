export type ConfigurationScope = 'user' | 'workspace' | 'folder';
export type ConfigurationControl =
    | 'toggle'
    | 'text'
    | 'number'
    | 'choice'
    | 'path'
    | 'list'
    | 'entries'
    | 'categories'
    | 'files'
    | 'renderer'
    | 'exceptions'
    | 'bindings'
    | 'advanced';

export interface ConfigurationField {
    key: string;
    group: string;
    control: ConfigurationControl;
    value: unknown;
    effective?: unknown;
    configured: boolean;
    source: ConfigurationScope | 'default';
    choices?: string[];
    picker?: 'file' | 'directory' | 'ini' | 'mix';
    immediate?: boolean;
}

export interface ConfigurationModel {
    id: string;
    origin: string;
    scope: ConfigurationScope;
    scopes: ConfigurationScope[];
    destination: string;
    fields: ConfigurationField[];
}

export interface ConfigurationChange {
    key: string;
    value?: unknown;
    reset?: boolean;
}

/** Each setting has one product owner; compatibility switches remain internal. */
export const CONFIGURATION_FIELDS: Omit<ConfigurationField, 'value' | 'effective' | 'configured' | 'source'>[] = [
    { key: 'validationFolderPath', group: 'loading', control: 'path', picker: 'directory' },
    { key: 'project.entryPoints', group: 'loading', control: 'entries', picker: 'ini' },
    { key: 'project.compatibility', group: 'loading', control: 'choice', choices: ['compatible', 'vanilla'] },
    { key: 'indexing.fileCategories', group: 'loading', control: 'categories' },
    { key: 'indexing.fileOverrides', group: 'loading', control: 'files', picker: 'ini' },
    { key: 'indexing.excludePatterns', group: 'loading', control: 'list' },
    { key: 'media.resourceRoots', group: 'resources', control: 'list', picker: 'directory' },
    { key: 'media.archiveOrder', group: 'resources', control: 'list', picker: 'mix' },
    { key: 'media.excludedDirectories', group: 'resources', control: 'list' },
    { key: 'schemaFilePath', group: 'dictionary', control: 'path', picker: 'ini' },
    { key: 'media.enabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'media.autoReveal', group: 'editing', control: 'toggle', immediate: true },
    { key: 'media.inlineThumbnails', group: 'editing', control: 'toggle', immediate: true },
    { key: 'media.hoverEnabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'codeLens.enabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'decorations.overrideIndicator.enabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'decorations.booleanPreview.enabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'decorations.csfPreview.enabled', group: 'editing', control: 'toggle', immediate: true },
    { key: 'decorations.csfPreview.maxLength', group: 'editing', control: 'number' },
    { key: 'media.theater', group: 'editing', control: 'choice', choices: ['tem', 'sno', 'urb', 'ubn', 'lun', 'des'] },
    { key: 'project.objectColumns', group: 'editing', control: 'list' },
    { key: 'media.semanticRules', group: 'editing', control: 'advanced' },
    { key: 'maps.renderer', group: 'maps', control: 'renderer' },
    { key: 'diagnostics.enabled', group: 'checks', control: 'toggle', immediate: true },
    { key: 'diagnostics.spacesBeforeComment', group: 'checks', control: 'number' },
    { key: 'diagnostics.excludePatterns', group: 'checks', control: 'list' },
    { key: 'diagnostics.overrides', group: 'checks', control: 'exceptions' },
    { key: 'exePath', group: 'validator', control: 'path', picker: 'file' },
    { key: 'validationFiles', group: 'validator', control: 'bindings', picker: 'ini' },
    { key: 'iniValidator.downloadUrl', group: 'validator', control: 'text' },
];
