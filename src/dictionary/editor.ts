import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID, randomBytes } from 'crypto';
import { localize } from '../i18n';
import { SchemaManager } from '../schema-manager';
import { DescriptionManager } from '../description-manager';
import { ProjectIni } from '../context/project-ini';
import { ProjectResources } from '../resources/project-resources';
import { parsePropertyLine } from '../context/ini-position';
import { DictionarySource, editedText } from './source-model';
import { DictionaryCatalog } from './catalog';
import { DictionaryDraft, DictionaryState } from './protocol';
import { keyPattern } from './key-pattern';

const VIEW = 'ra2-ini-intellisense.dictionary';
const labelDefaults: Record<string, string> = {
    title: 'Dictionary editor', search: 'Search tags, descriptions, types or sources', types: 'Types', tags: 'Tags',
    definition: 'Definition', description: 'Description', source: 'Source', inherited: 'Inherited from', local: 'Current dictionary',
    override: 'Apply override', apply: 'Apply changes', save: 'Save and reload', discard: 'Discard form changes',
    openSource: 'Open source', newTag: 'Add tag', newType: 'Add type', name: 'Name', valueType: 'Value type',
    default: 'Default value', noDefault: 'No default specified', fileType: 'File purpose', generic: 'Any file',
    object: 'Object / global section', number: 'Integer range', limit: 'Text / enumeration', list: 'List', registry: 'Registries',
    base: 'Parent type', range: 'Range (minimum, maximum)', enum: 'Allowed values (comma separated)',
    prefix: 'Allowed prefixes', suffix: 'Allowed suffixes', caseSensitive: 'Case sensitive', element: 'Element type',
    descriptions: 'Descriptions', preview: 'Hover preview', examples: 'Project examples', usages: 'Find usages',
    empty: 'Select a type or add a tag.', dirty: 'Unsaved dictionary documents', clean: 'Saved',
    protected: 'This downloaded dictionary is read-only. Create a project copy to preserve your changes across updates.',
    copy: 'Create project copy', remove: 'Remove local definition', issues: 'Dictionary problems', reload: 'Refresh',
    changed: 'The dictionary changed. Your form is preserved; discard or review it before applying again.',
    saved: 'Dictionary saved and reloaded.', syntax: 'Open text editor', pattern: 'Numbered keys use Prefix(minimum,maximum)Suffix.',
    plainDescription: 'Markdown text. Preview shows the content; use Open source for the original document.',
    loading: 'Loading dictionary…',
    confirmType: 'Confirm the value type before applying this new tag.',
};

function labels(): Record<string, string> {
    return Object.fromEntries(Object.entries(labelDefaults).map(([key, value]) => [key, localize('dictionary.editor.' + key, value)]));
}

/** Shared text documents provide native undo and preserve text-editor changes in included files. */
export class DictionaryEditor implements vscode.CustomTextEditorProvider, vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly focusChanged = new vscode.EventEmitter<string>();
    private readonly origins = new Map<string, { uri: vscode.Uri; type?: string; key?: string; suggested?: string }>();
    constructor(private readonly context: vscode.ExtensionContext, private readonly schema: SchemaManager,
        private readonly descriptions: DescriptionManager, private readonly project: ProjectIni, private readonly resources: ProjectResources, register = true) {
        if (register) { this.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW, this, { webviewOptions: { retainContextWhenHidden: true } }),
            vscode.commands.registerCommand('ra2-ini-intellisense.editDictionary', (uri?: vscode.Uri) => this.open(uri)));
        }
    }
    public async open(uri?: vscode.Uri): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const origin = uri instanceof vscode.Uri ? uri : editor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const configured = vscode.workspace.getConfiguration('ra2-ini-intellisense', origin).get<string>('schemaFilePath', '');
        if (!configured) { await vscode.commands.executeCommand('ra2-ini-intellisense.configureSchemaPath'); return; }
        const dictionary = vscode.Uri.file(path.isAbsolute(configured) ? configured : path.resolve(this.resources.projectRoot(origin ?? vscode.Uri.file(path.dirname(configured))).fsPath, configured));
        let type: string | undefined, key: string | undefined, suggested: string | undefined;
        if (editor && origin && this.resources.contains(origin, editor.document.uri) && editor.document.uri.toString() !== dictionary.toString() && editor.document.languageId === 'ra2-ini') {
            await this.project.load(editor.document.uri);
            const section = this.project.parse(editor.document).getSectionAt(editor.selection.active.line);
            if (section) {
                type = this.project.type(editor.document.uri, section.name);
                const property = parsePropertyLine(editor.document.lineAt(editor.selection.active.line).text);
                key = property?.key;
                const definition = key && this.schema.getProperty(type, key);
                if (definition) { key = definition.declaration ?? key; }
                else if (property) {
                    const registered = this.project.registeredTypes(editor.document.uri, property.value);
                    suggested = registered.length === 1 ? registered[0] : /^(yes|no|true|false)$/i.test(property.value) ? 'bool' : /^[+-]?\d+$/.test(property.value) ? 'int' : /^[+-]?(?:\d+\.\d*|\.\d+)%?$/.test(property.value) ? 'float' : 'string';
                }
            }
        }
        if (origin) { this.origins.set(dictionary.toString(), { uri: origin, type, key, suggested }); }
        this.focusChanged.fire(dictionary.toString());
        await vscode.commands.executeCommand('vscode.openWith', dictionary, VIEW);
    }
    public async resolveCustomTextEditor(root: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench')] };
        const nonce = randomBytes(18).toString('base64');
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench', 'dictionary.js'));
        const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench', 'dictionary.css'));
        panel.webview.html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + panel.webview.cspSource + '; script-src \'nonce-' + nonce + '\';">' +
            '<link rel="stylesheet" href="' + style + '"><title>' + labels().title + '</title></head><body><main id="dictionary"><p>' + labels().loading + '</p></main><script nonce="' + nonce + '" src="' + script + '"></script></body></html>';
        let revision = '', versions = new Map<string, number>(), documents = new Map<string, vscode.TextDocument>();
        let catalog: DictionaryCatalog | undefined, selected = this.origins.get(root.uri.toString())?.type ?? '', ready = false, busy = false, disposed = false;
        let languageFiles = new Map<string, vscode.TextDocument>();
        let initialKey = this.origins.get(root.uri.toString())?.key;
        const exampleLinks = new Map<string, vscode.Location>();
        const protectedRoot = () => root.uri.fsPath.toLowerCase().startsWith((this.context.globalStorageUri.fsPath + path.sep).toLowerCase());
        const refresh = async (error?: string) => {
            if (!ready || disposed || busy) { return; }
            busy = true;
            try {
                const files: { path: string; source: DictionarySource }[] = [], issues: DictionaryState['issues'] = [];
                documents = new Map(); languageFiles = new Map();
                const seen = new Set<string>(), stack = new Set<string>();
                const read = async (document: vscode.TextDocument, depth: number) => {
                    const id = document.uri.toString(), source = new DictionarySource(document.getText());
                    if (seen.has(id)) { return; }
                    seen.add(id); stack.add(id); documents.set(id, document);
                    for (const include of source.inSection('#include')) {
                        const name = include.value ?? include.key;
                        const uri = vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), name));
                        if (stack.has(uri.toString())) { issues.push({ path: document.uri.fsPath, line: include.line, message: localize('dictionary.error.includeCycle', 'Dictionary include cycle: {0}', name) }); continue; }
                        if (depth >= 32 || seen.size >= 64) { issues.push({ path: document.uri.fsPath, line: include.line, message: localize('dictionary.error.limit', 'Dictionary include limit reached (64 files / 32 levels).') }); continue; }
                        try { await read(await vscode.workspace.openTextDocument(uri), depth + 1); }
                        catch { issues.push({ path: document.uri.fsPath, line: include.line, message: localize('dictionary.error.includeMissing', 'Cannot read included dictionary: {0}', name) }); }
                    }
                    stack.delete(id); files.push({ path: document.uri.fsPath, source });
                };
                await read(root, 0);
        const rootSource = new DictionarySource(root.getText());
                for (const entry of rootSource.inSection('Description')) {
                    if (!entry.value) { continue; }
                    try {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(path.dirname(root.uri.fsPath), entry.value)));
                        documents.set(document.uri.toString(), document); languageFiles.set(entry.key, document);
                    } catch { issues.push({ path: root.uri.fsPath, line: entry.line, message: localize('dictionary.error.descriptionMissing', 'Cannot read description file: {0}', entry.value) }); }
                }
                catalog = new DictionaryCatalog(files, root.uri.fsPath);
                versions = new Map([...documents].map(([id, document]) => [id, document.version])); revision = randomUUID();
                if (!catalog.types.has(selected.toLowerCase())) { selected = catalog.types.values().next().value?.name ?? ''; initialKey = undefined; }
                const descriptionSources = [...languageFiles.values()].map(document => new DictionarySource(document.getText()));
                const descriptionIndex = new Map(descriptionSources.flatMap(source => source.entries.map(entry => [entry.section.toLowerCase() + ':' + entry.key.toLowerCase(), entry.value?.slice(0, 500) ?? ''] as const)));
                const state: DictionaryState = { revision, path: root.uri.fsPath, dirty: [...documents.values()].some(document => document.isDirty), protected: protectedRoot(),
                    types: [...catalog.types.values()].sort((a, b) => a.name.localeCompare(b.name)), valueTypes: [...new Set([...catalog.types.values()].map(type => type.name).concat(['int', 'float', 'double', 'string', 'bool']))],
                    search: [...catalog.types.values()].flatMap(type => catalog!.detail(type.name).properties.map(property => ({ section: type.name, key: property.key, text: [property.type, property.path, property.owner, descriptionIndex.get(property.owner.toLowerCase() + ':' + property.key.toLowerCase()) ?? ''].join(' ') }))),
                    issues: [...issues, ...catalog.problems().map(issue => ({ ...issue, message: localize('dictionary.problem.' + issue.message, issue.message, ...issue.args) })), ...catalog.issues.map(issue => ({ ...issue, message: localize('dictionary.error.multiline', 'Unterminated multiline description.') }))], detail: selected ? catalog.detail(selected) : undefined, error, labels: labels() };
                await panel.webview.postMessage({ type: 'state', state, key: initialKey, suggested: this.origins.get(root.uri.toString())?.suggested }); initialKey = undefined;
            } finally { busy = false; }
        };
        const fail = async (error: unknown) => {
            console.error('[Dictionary editor]', error);
            await panel.webview.postMessage({ type: 'failure', error: error instanceof Error ? error.message : String(error) });
        };
        const stale = () => [...documents].some(([id, document]) => versions.get(id) !== document.version);
        const put = (text: string, section: string, key: string, value: string | undefined, description = false) => editedText(text, [new DictionarySource(text).set(section, key, value, description)]);
        const patch = (edit: vscode.WorkspaceEdit, document: vscode.TextDocument, text: string) => {
            const before = document.getText();
            let start = 0, end = before.length, tail = text.length;
            while (start < end && start < tail && before[start] === text[start]) { start++; }
            while (end > start && tail > start && before[end - 1] === text[tail - 1]) { end--; tail--; }
            if (start !== end || start !== tail) { edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text.slice(start, tail)); }
        };
        let queue = Promise.resolve();
        const handle = async (message: { type?: string; revision?: string; name?: string; key?: string; draft?: DictionaryDraft; language?: string; id?: string }) => {
            if (disposed) { return; }
            if (message.type === 'ready') { ready = true; await refresh(); return; }
            if (message.type === 'refresh') { await refresh(); return; }
            if (message.type === 'select' && typeof message.name === 'string' && catalog?.types.has(message.name.toLowerCase())) {
                selected = message.name; await refresh(); return;
            }
            if (message.type === 'source' && catalog) {
                const property = catalog.detail(selected).properties.find(item => item.key === message.key);
                const document = property ? [...documents.values()].find(item => item.uri.fsPath === property.path) : root;
                if (document) { await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(property?.line ?? 0, 0, property?.line ?? 0, 0) }); }
                return;
            }
            if (message.type === 'description' && typeof message.key === 'string') {
                const descriptions: Record<string, string> = {};
                for (const [language, document] of languageFiles) {
                    const source = new DictionarySource(document.getText());
                    descriptions[language] = source.description(selected, message.key, name => catalog?.types.get(name.toLowerCase())?.base) ?? '';
                }
                for (const language of ['zh-CN', 'en-US']) { descriptions[language] ??= ''; }
                await panel.webview.postMessage({ type: 'description', key: message.key, section: selected, revision, descriptions,
                    preview: this.descriptions.getDescription(selected, this.schema.getProperty(selected, message.key)?.declaration ?? message.key) ?? '' });
                return;
            }
            if (message.type === 'examples' && typeof message.key === 'string') {
                const origin = this.origins.get(root.uri.toString())?.uri;
                if (!origin) { return; }
                await this.project.load(origin);
                const examples: { id: string; path: string; section: string; key: string; value: string; line: number }[] = []; exampleLinks.clear();
                for (const document of this.project.documents(origin)) {
                    for (const section of document.sections) {
                        if (!this.schema.isAssignable(this.project.type(origin, section.name, this.project.category(document.uri)), selected)) { continue; }
                        for (let line = section.startLine + 1; line <= section.endLine; line++) {
                            const property = parsePropertyLine(document.lines[line] ?? '');
                            if (property && (property.key.toLowerCase() === message.key.toLowerCase() || this.schema.getProperty(selected, property.key)?.declaration === message.key)) {
                                const id = randomUUID(); exampleLinks.set(id, new vscode.Location(document.uri, new vscode.Position(line, property.keyStart)));
                                examples.push({ id, path: document.uri.fsPath, section: section.name, key: property.key, value: property.value, line });
                            }
                            if (examples.length >= 30) { break; }
                        }
                        if (examples.length >= 30) { break; }
                    }
                    if (examples.length >= 30) { break; }
                }
                await panel.webview.postMessage({ type: 'examples', key: message.key, section: selected, examples }); return;
            }
            if (message.type === 'example-open' && typeof message.id === 'string') {
                const location = exampleLinks.get(message.id);
                if (location) { await vscode.window.showTextDocument(location.uri, { viewColumn: vscode.ViewColumn.Beside, selection: location.range }); }
                return;
            }
            if (message.type === 'copy') { await this.copy(root, this.origins.get(root.uri.toString())?.uri); return; }
            if (message.type === 'save') {
                if (protectedRoot()) { throw new Error(labels().protected); }
                if (stale()) { throw new Error(labels().changed); }
                for (const document of documents.values()) {
                    if (document.isDirty && !await document.save()) { throw new Error(localize('dictionary.error.save', 'Could not save {0}.', document.uri.fsPath)); }
                }
                await vscode.commands.executeCommand('ra2-ini-intellisense.reloadDictionary', this.origins.get(root.uri.toString())?.uri);
                await refresh(); return;
            }
            if (message.type !== 'apply' || !message.draft || !catalog) { return; }
            if (protectedRoot()) { throw new Error(labels().protected); }
            if (message.revision !== revision || stale()) { throw new Error(labels().changed); }
            const draft = message.draft;
            this.validateDraft(draft, catalog);
            if (draft.valueType) { draft.valueType = catalog.types.get(draft.valueType.toLowerCase())?.name ?? draft.valueType; }
            if (draft.base) { draft.base = catalog.types.get(draft.base.toLowerCase())?.name ?? draft.base; }
            if (draft.fields?.Type) { draft.fields.Type = catalog.types.get(draft.fields.Type.toLowerCase())?.name ?? draft.fields.Type; }
            let text = root.getText();
            const edit = new vscode.WorkspaceEdit();
            if (draft.remove) {
                const entry = new DictionarySource(text).find(draft.section, draft.key!);
                if (!entry) { throw new Error(localize('dictionary.error.remove', 'Only local declarations can be removed.')); }
                text = editedText(text, [{ start: entry.start, end: entry.end, text: '' }]);
            } else if (draft.key) {
                if (!catalog.types.has(draft.section.toLowerCase())) { text = put(text, 'Sections', draft.section, undefined); }
                const value = draft.kind === 'registry' ? draft.valueType! : [draft.valueType!, draft.defaultValue ?? '', draft.fileType ?? ''].join(',').replace(/,+$/, '');
                text = put(text, draft.section, draft.key, value);
            } else {
                const categories = { object: 'Sections', number: 'NumberLimits', limit: 'Limits', list: 'Lists', registry: 'Registries' };
                if (!catalog.types.has(draft.section.toLowerCase())) { text = put(text, categories[draft.kind], draft.section, undefined); }
                for (const [key, value] of Object.entries(draft.fields ?? {})) { text = put(text, draft.section, key, value); }
                if (draft.kind === 'object') {
                    const source = new DictionarySource(text), section = source.sections.filter(item => item.name.toLowerCase() === draft.section.toLowerCase()).at(-1);
                    if (section) {
                        const heading = text.slice(section.start, section.headingEnd);
                        const start = section.start;
                        const comment = heading.indexOf(';');
                        const indentation = /^\uFEFF?\s*/.exec(heading)?.[0] ?? /^\s*/.exec(heading)?.[0] ?? '';
                        text = editedText(text, [{ start, end: start + heading.length, text: indentation + '[' + draft.section + ']' + (draft.base ? ':[' + draft.base + ']' : '') + (comment >= 0 ? ' ' + heading.slice(comment) : '') }]);
                    } else { text += new DictionarySource(text).eol + '[' + draft.section + ']' + (draft.base ? ':[' + draft.base + ']' : '') + new DictionarySource(text).eol; }
                }
            }
            for (const [language, value] of Object.entries(draft.descriptions ?? {})) {
                const document = languageFiles.get(language);
                if (document) { patch(edit, document, put(document.getText(), draft.section, draft.key!, value, true)); }
                else {
                    const relative = 'descriptions/local-' + language + '.ini';
                    const uri = vscode.Uri.file(path.join(path.dirname(root.uri.fsPath), relative));
                    try { await vscode.workspace.fs.stat(uri); throw new Error(localize('dictionary.error.descriptionConflict', 'Description file exists but is not mapped: {0}. Add it to [Description] first.', relative)); }
                    catch (error) { if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) { throw error; } }
                    edit.createFile(uri, { overwrite: false });
                    edit.insert(uri, new vscode.Position(0, 0), put('', draft.section, draft.key!, value, true));
                    text = put(text, 'Description', language, relative);
                }
            }
            patch(edit, root, text);
            if (stale()) { throw new Error(labels().changed); }
            busy = true;
            try { if (!await vscode.workspace.applyEdit(edit)) { throw new Error(localize('dictionary.error.apply', 'The dictionary edit could not be applied.')); } }
            finally { busy = false; }
            selected = draft.section;
            await panel.webview.postMessage({ type: 'applied' }); await refresh();
        };
        const listeners = [this.focusChanged.event(id => {
            if (id !== root.uri.toString()) { return; }
            const focus = this.origins.get(id);
            queue = queue.then(async () => { selected = focus?.type ?? selected; initialKey = focus?.key; await refresh(); }).catch(fail);
        }), panel.webview.onDidReceiveMessage(message => {
            if (!message || typeof message !== 'object') { return; }
            queue = queue.then(() => handle(message)).catch(fail);
        }), vscode.workspace.onDidChangeTextDocument(event => {
            if (documents.has(event.document.uri.toString())) { queue = queue.then(() => refresh()).catch(fail); }
        }), vscode.workspace.onDidSaveTextDocument(document => {
            if (documents.has(document.uri.toString())) { queue = queue.then(() => refresh()).catch(fail); }
        })];
        panel.onDidDispose(() => { disposed = true; listeners.forEach(listener => listener.dispose()); });
    }
    private validateDraft(draft: DictionaryDraft, catalog: DictionaryCatalog): void {
        const invalid = () => { throw new Error(localize('dictionary.error.invalid', 'Invalid dictionary definition. Check the name, type, range and default value.')); };
        if (typeof draft.section !== 'string' || !/^[\w.<>-]{1,128}$/.test(draft.section) || !['object', 'number', 'limit', 'list', 'registry'].includes(draft.kind)) { invalid(); }
        if (catalog.types.has(draft.section.toLowerCase()) && catalog.types.get(draft.section.toLowerCase())?.kind !== draft.kind) { invalid(); }
        if (['#include', 'description', 'sections', 'globals', 'numberlimits', 'limits', 'lists'].includes(draft.section.toLowerCase())) { invalid(); }
        if (draft.key !== undefined && (typeof draft.key !== 'string' || !/^[\w.()<>,-]{1,256}$/.test(draft.key))) { invalid(); }
        if (draft.remove) { if (!draft.key || draft.descriptions) { invalid(); } return; }
        const known = (name: string | undefined) => !!name && (['int', 'float', 'double', 'string', 'bool'].includes(name) || catalog.types.has(name.toLowerCase()));
        if (draft.key && !known(draft.valueType)) { invalid(); }
        if (draft.defaultValue !== undefined && (typeof draft.defaultValue !== 'string' || /[,;\r\n]/.test(draft.defaultValue) || draft.defaultValue.length > 1024)) { invalid(); }
        if (draft.fileType && !/^[a-z][\w.-]{0,63}$/i.test(draft.fileType)) { invalid(); }
        if (draft.defaultValue && draft.valueType === 'int' && !/^[+-]?\d+$/.test(draft.defaultValue)) { invalid(); }
        if (draft.defaultValue && draft.valueType === 'bool' && !/^(yes|no|true|false|0|1)$/i.test(draft.defaultValue)) { invalid(); }
        if (draft.defaultValue && draft.valueType && !catalog.validDefault(draft.defaultValue, draft.valueType)) { invalid(); }
        if (draft.key?.includes('(') && !keyPattern(draft.key)) { invalid(); }
        const fields = draft.fields ?? {};
        const allowed = { object: [], registry: [], number: ['Range'], limit: ['LimitIn', 'StartWith', 'EndWith', 'CaseSensitive'], list: ['Type', 'Range'] };
        for (const [key, value] of Object.entries(fields)) {
            if (!allowed[draft.kind].includes(key as never) || typeof value !== 'string' || /[;\r\n]/.test(value) || value.length > 16000) { invalid(); }
        }
        if (draft.kind === 'number' || (draft.kind === 'list' && fields.Range)) {
            const parts = fields.Range?.split(',').map(value => value.trim());
            const range = parts?.every(value => /^[+-]?\d+$/.test(value)) ? parts.map(Number) : undefined;
            if (!range || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] > range[1] || (draft.kind === 'list' && range[0] < 0)) { invalid(); }
        }
        if (draft.kind === 'list' && !known(fields.Type)) { invalid(); }
        let parent = draft.base, visited = new Set([draft.section.toLowerCase()]);
        while (parent) {
            if (catalog.types.get(parent.toLowerCase())?.kind !== 'object' || visited.has(parent.toLowerCase())) { invalid(); }
            visited.add(parent.toLowerCase()); parent = catalog.types.get(parent.toLowerCase())?.base;
        }
        if (draft.kind === 'list') {
            let member = fields.Type; visited = new Set([draft.section.toLowerCase()]);
            while (member && catalog.types.get(member.toLowerCase())?.kind === 'list') {
                if (visited.has(member.toLowerCase())) { invalid(); }
                visited.add(member.toLowerCase()); member = catalog.detail(member).fields.Type;
            }
        }
        for (const [language, value] of Object.entries(draft.descriptions ?? {})) {
            if (!draft.key || !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(language) || typeof value !== 'string' || value.length > 64000 || value.includes('"""')) { invalid(); }
        }
    }
    private async copy(root: vscode.TextDocument, origin?: vscode.Uri): Promise<void> {
        const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(this.resources.projectRoot(origin ?? root.uri), '.ra2', 'INIDictionary.ini'), filters: { INI: ['ini'] } });
        if (!destination || destination.toString() === root.uri.toString()) { return; }
        let text = root.getText();
        if (vscode.workspace.textDocuments.some(document => document.uri.toString() === destination.toString() && document.isDirty)) { throw new Error(labels().changed); }
        const source = new DictionarySource(text), edits = source.inSection('#include').map(entry => ({ start: entry.valueStart, end: entry.valueEnd, text: path.resolve(path.dirname(root.uri.fsPath), entry.value ?? entry.key) }));
        text = editedText(text, edits);
        await vscode.workspace.fs.createDirectory(destination.with({ path: path.posix.dirname(destination.path) }));
        const copyId = randomUUID().slice(0, 8);
        for (const entry of source.inSection('Description')) {
            if (!entry.value) { continue; }
            const uri = vscode.Uri.file(path.resolve(path.dirname(root.uri.fsPath), entry.value));
            const document = await vscode.workspace.openTextDocument(uri);
            const relative = 'descriptions/copy-' + copyId + '-' + entry.key + '.ini', target = vscode.Uri.joinPath(destination.with({ path: path.posix.dirname(destination.path) }), relative);
            await vscode.workspace.fs.createDirectory(target.with({ path: path.posix.dirname(target.path) }));
            await vscode.workspace.fs.writeFile(target, Buffer.from(document.getText(), 'utf8'));
            text = editedText(text, [new DictionarySource(text).set('Description', entry.key, relative)]);
        }
        await vscode.workspace.fs.writeFile(destination, Buffer.from(text, 'utf8'));
        await vscode.workspace.getConfiguration('ra2-ini-intellisense', origin).update('schemaFilePath', destination.fsPath, vscode.workspace.getWorkspaceFolder(origin ?? destination) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        if (origin) { this.origins.set(destination.toString(), { uri: origin }); }
        await vscode.commands.executeCommand('vscode.openWith', destination, VIEW);
    }
    public dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.origins.clear(); this.focusChanged.dispose(); }
}
