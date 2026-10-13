import './dictionary.css';
import type { DictionaryDraft, DictionaryProperty, DictionaryState } from '../../src/dictionary/protocol';
import MarkdownIt from 'markdown-it';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; getState(): { key?: string } | undefined; setState(value: unknown): void };
const api = acquireVsCodeApi();
const markdown = new MarkdownIt({ html: false, linkify: false }).disable('image');
markdown.validateLink = value => /^https?:\/\//i.test(value);
const host = document.querySelector<HTMLElement>('#dictionary')!;
let state: DictionaryState, latest: DictionaryState | undefined, key = api.getState()?.key ?? '', query = '';
let form: DictionaryDraft | undefined, baseline = '', pending = false;
let languageBaseline: Record<string, string> = {}, preview = '', examples: { id: string; text: string }[] = [];
let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
const post = (type: string, data: object = {}) => api.postMessage({ type, revision: state?.revision, ...data });
const label = (name: string) => state.labels[name] ?? name;
const typeLabel = (name: string) => name === 'UnitType' ? 'VehicleType' : name;
const dirty = () => !!form && JSON.stringify(form) !== baseline;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function button(text: string, run: () => void, disabled = false): HTMLButtonElement {
    const element = node('button', text); element.type = 'button'; element.disabled = disabled || pending;
    element.onclick = run; return element;
}
function input(container: HTMLElement, title: string, value: string, update: (value: string) => void, options?: string[], multiline = false): HTMLInputElement | HTMLTextAreaElement {
    const row = node('label', '', 'dictionary-field'); row.append(node('span', title));
    const element = multiline ? node('textarea') : node('input'); element.value = value;
    element.disabled = pending || state.protected; element.oninput = () => { update(element.value); updateActions(); };
    if (options && element instanceof HTMLInputElement) {
        const list = node('datalist'); list.id = 'choices-' + Math.random().toString(36).slice(2);
        for (const value of options) { const option = node('option'); option.value = value; list.append(option); }
        element.setAttribute('list', list.id); row.append(list);
    }
    row.append(element); container.append(row); return element;
}
function newForm(property?: DictionaryProperty): void {
    const detail = state.detail;
    if (!detail) { return; }
    const editable = { object: [], registry: [], number: ['Range'], list: ['Type', 'Range'], limit: ['LimitIn', 'StartWith', 'EndWith', 'CaseSensitive'] };
    const fields = Object.fromEntries(editable[detail.kind].flatMap(key => {
        const found = Object.entries(detail.fields).find(([name]) => name.toLowerCase() === key.toLowerCase());
        return found ? [[key, found[1]]] : [];
    }));
    form = property ? { section: detail.name, kind: detail.kind, key: property.key, valueType: property.type, defaultValue: property.defaultValue, fileType: property.fileType }
        : { section: detail.name, kind: detail.kind, fields, base: detail.base };
    baseline = JSON.stringify(form); languageBaseline = {}; preview = ''; examples = [];
    if (property) { post('description', { key: property.key }); }
}
function selectProperty(property: DictionaryProperty): void {
    if (dirty()) { return; }
    key = property.key; api.setState({ key }); newForm(property); render();
}
function updateActions(): void {
    const apply = host.querySelector<HTMLButtonElement>('[data-action="apply"]');
    if (apply) { apply.disabled = pending || state.protected || !dirty(); }
    const save = host.querySelector<HTMLButtonElement>('[data-action="save"]');
    if (save) { save.disabled = pending || state.protected || dirty() || !state.dirty; }
    const discard = host.querySelector<HTMLButtonElement>('[data-action="discard"]');
    if (discard) { discard.hidden = !dirty(); }
    host.querySelectorAll<HTMLButtonElement>('[data-navigation]').forEach(element => { element.disabled = pending || dirty(); });
}
function error(text: string): void {
    const element = host.querySelector<HTMLElement>('.dictionary-message'); if (element) { element.textContent = text; element.hidden = !text; }
}
function render(): void {
    host.replaceChildren();
    const toolbar = node('header', '', 'dictionary-toolbar');
    const title = node('div'); title.append(node('h1', label('title')), node('small', state.path)); toolbar.append(title);
    toolbar.append(node('span', label(state.dirty ? 'dirty' : 'clean'), 'dictionary-status'));
    const save = button(label('save'), () => { pending = true; post('save'); render(); }); save.dataset.action = 'save'; toolbar.append(save);
    toolbar.append(button(label('syntax'), () => post('source')));
    const refresh = button(label('reload'), () => post('refresh')); refresh.dataset.navigation = ''; toolbar.append(refresh);
    toolbar.append(button(label('copy'), () => post('copy'))); host.append(toolbar);
    const message = node('p', state.error ?? '', 'dictionary-message'); message.hidden = !state.error; message.setAttribute('role', 'alert'); host.append(message);
    if (state.protected) { host.append(node('p', label('protected'), 'dictionary-notice')); }
    const search = node('input'); search.type = 'search'; search.placeholder = label('search'); search.setAttribute('aria-label', label('search')); search.value = query;
    search.oninput = () => { query = search.value; renderLists(); }; host.append(search);
    const layout = node('div', '', 'dictionary-layout'); host.append(layout);
    const types = node('nav', '', 'dictionary-types'); types.setAttribute('aria-label', label('types')); layout.append(types);
    const tags = node('section', '', 'dictionary-tags'); layout.append(tags);
    const details = node('section', '', 'dictionary-details'); layout.append(details);
    types.append(node('h2', label('types')));
    const addType = button(label('newType'), () => {
        form = { section: '', kind: 'object', fields: {} }; key = ''; baseline = ''; render();
    }, state.protected); addType.dataset.navigation = ''; types.append(addType, node('div', '', 'dictionary-type-list'));
    tags.append(node('h2', state.detail ? typeLabel(state.detail.name) : label('tags')));
    if (state.detail?.base) { tags.append(node('small', label('inherited') + ' ' + state.detail.base)); }
    if (state.detail?.kind === 'object' || state.detail?.kind === 'registry') {
        const add = button(label('newTag'), () => { form = { section: state.detail!.name, kind: state.detail!.kind, key: '', valueType: 'string' }; key = ''; baseline = ''; languageBaseline = {}; render(); }, state.protected);
        add.dataset.navigation = ''; tags.append(add);
        if (state.detail.kind === 'object') {
            const editType = button(label('base'), () => { key = ''; newForm(); render(); }); editType.dataset.navigation = ''; tags.append(editType);
        }
    }
    tags.append(node('div', '', 'dictionary-tag-list'));
    if (form) { renderForm(details); } else { details.append(node('p', label('empty'))); }
    if (state.issues.length) {
        const problems = node('details', '', 'dictionary-problems'); problems.append(node('summary', label('issues') + ' · ' + state.issues.length));
        for (const issue of state.issues) { problems.append(node('p', issue.message + ' — ' + issue.path + ':' + (issue.line + 1))); } host.append(problems);
    }
    renderLists(); updateActions();
}
function renderLists(): void {
    const types = host.querySelector('.dictionary-type-list')!, tags = host.querySelector('.dictionary-tag-list')!;
    types.replaceChildren(); tags.replaceChildren(); const term = query.toLowerCase();
    for (const type of state.types) {
        if (term && ![type.name, label(type.kind), type.base ?? ''].join(' ').toLowerCase().includes(term) && !state.search.some(item => item.section === type.name && [item.key, item.text].join(' ').toLowerCase().includes(term))) { continue; }
        const choice = button(typeLabel(type.name), () => { key = ''; form = undefined; post('select', { name: type.name }); });
        choice.title = type.name + ' · ' + label(type.kind); choice.dataset.navigation = '';
        choice.setAttribute('aria-current', String(state.detail?.name === type.name)); types.append(choice);
    }
    for (const property of state.detail?.properties ?? []) {
        if (term && ![state.detail?.name, property.key, property.type, property.path, property.owner, state.search.find(item => item.section === state.detail?.name && item.key === property.key)?.text].join(' ').toLowerCase().includes(term)) { continue; }
        const choice = button('', () => selectProperty(property)); choice.dataset.navigation = '';
        choice.append(node('strong', property.key), node('small', property.type + ' · ' + (property.inherited ? label('inherited') + ' ' + property.owner : property.local ? label('local') : property.path.split(/[\\/]/).at(-1))));
        choice.setAttribute('aria-current', String(key === property.key)); tags.append(choice);
    }
    updateActions();
}
function renderForm(container: HTMLElement): void {
    const draft = form!;
    container.append(node('h2', label('definition')));
    const sectionInput = input(container, label('name'), draft.section, value => { draft.section = value; });
    sectionInput.readOnly = state.types.some(type => type.name === draft.section);
    if (draft.key !== undefined) {
        input(container, 'Tag', draft.key, value => { draft.key = value; });
        container.append(node('small', label('pattern')));
        input(container, label('valueType'), draft.valueType ?? '', value => { draft.valueType = value; }, state.valueTypes);
        if (!state.detail?.properties.some(property => property.key === draft.key)) { container.append(node('small', label('confirmType'))); }
        if (draft.kind !== 'registry') {
            const defaultToggle = node('label', '', 'dictionary-checkbox'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = draft.defaultValue !== undefined;
            checkbox.disabled = pending || state.protected; defaultToggle.append(checkbox, node('span', label('default'))); container.append(defaultToggle);
            const defaultInput = input(container, label('default'), draft.defaultValue ?? '', value => { draft.defaultValue = value; }); defaultInput.disabled ||= !checkbox.checked;
            checkbox.onchange = () => { draft.defaultValue = checkbox.checked ? defaultInput.value : undefined; defaultInput.disabled = !checkbox.checked; updateActions(); };
            input(container, label('fileType'), draft.fileType ?? '', value => { draft.fileType = value || undefined; }, ['rules', 'art', 'sound', 'ai', 'eva', 'ui', 'theme']);
        }
        const property = state.detail?.properties.find(item => item.key === key);
        if (property) {
            container.append(node('p', label('source') + ': ' + property.path + ':' + (property.line + 1), 'dictionary-source'));
            container.append(button(label('openSource'), () => post('source', { key })));
            container.append(button(label('usages'), () => post('examples', { key })));
        }
        const descriptions = node('details', '', 'dictionary-description'); descriptions.open = true; descriptions.append(node('summary', label('descriptions')));
        const languageSelect = node('select'); languageSelect.setAttribute('aria-label', label('descriptions'));
        for (const item of Object.keys(languageBaseline)) { const option = node('option', item); option.value = item; languageSelect.append(option); }
        languageSelect.value = language; languageSelect.onchange = () => { language = languageSelect.value; render(); }; descriptions.append(languageSelect);
        if (languageBaseline[language] !== undefined) {
            input(descriptions, language, draft.descriptions?.[language] ?? languageBaseline[language], value => {
                draft.descriptions ??= {};
                if (value === languageBaseline[language]) { delete draft.descriptions[language]; } else { draft.descriptions[language] = value; }
                if (!Object.keys(draft.descriptions).length) { delete draft.descriptions; }
                const display = descriptions.querySelector('.dictionary-preview'); if (display) { display.innerHTML = markdown.render(value); }
            }, undefined, true);
        }
        const rendered = node('div', '', 'dictionary-preview');
        rendered.innerHTML = markdown.render(draft.descriptions?.[language] ?? languageBaseline[language] ?? preview);
        descriptions.append(node('small', label('plainDescription')), node('h3', label('preview')), rendered); container.append(descriptions);
        if (examples.length) {
            container.append(node('h3', label('examples')));
            for (const example of examples) { const link = button(example.text, () => post('example-open', { id: example.id })); link.className = 'dictionary-example'; container.append(link); }
        }
    } else {
        const kind = node('label', '', 'dictionary-field'); kind.append(node('span', label('valueType'))); const select = node('select');
        for (const value of ['object', 'number', 'limit', 'list'] as const) { const option = node('option', label(value)); option.value = value; select.append(option); }
        select.value = draft.kind; select.disabled = pending || state.protected || !!state.types.find(item => item.name === draft.section);
        select.onchange = () => { draft.kind = select.value as DictionaryDraft['kind']; draft.fields = {}; render(); }; kind.append(select); container.append(kind);
        const fields = draft.fields ??= {};
        if (draft.kind === 'object') { input(container, label('base'), draft.base ?? '', value => { draft.base = value || undefined; }, state.types.filter(type => type.kind === 'object').map(type => type.name)); }
        if (draft.kind === 'list') { input(container, label('element'), fields.Type ?? '', value => { fields.Type = value; }, state.valueTypes); }
        if (draft.kind === 'number' || draft.kind === 'list') { input(container, label('range'), fields.Range ?? '', value => { fields.Range = value; }); }
        if (draft.kind === 'limit') {
            for (const [field, title] of [['LimitIn', 'enum'], ['StartWith', 'prefix'], ['EndWith', 'suffix'], ['CaseSensitive', 'caseSensitive']]) {
                input(container, label(title), fields[field] ?? '', value => { fields[field] = value; }, field === 'CaseSensitive' ? ['yes', 'no'] : undefined);
            }
        }
    }
    const actions = node('footer', '', 'dictionary-actions');
    const apply = button(label('apply'), () => {
        pending = true; post('apply', { draft }); render();
    }); apply.dataset.action = 'apply'; actions.append(apply);
    const discard = button(label('discard'), () => {
        if (latest) { state = latest; latest = undefined; }
        const property = state.detail?.properties.find(item => item.key === key);
        newForm(property); render();
    }); discard.dataset.action = 'discard'; actions.append(discard);
    if (draft.key && state.detail?.properties.some(item => item.key === key && item.local && !item.inherited)) {
        actions.append(button(label('remove'), () => {
            form = { section: state.detail!.name, kind: state.detail!.kind, key, remove: true }; baseline = ''; render();
        }, dirty()));
    }
    container.append(actions);
}
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
        pending = false;
        if (state && dirty()) { latest = message.state; error(label('changed')); updateActions(); return; }
        state = message.state; key = message.key ?? key;
        if (message.key && !state.detail?.properties.some(item => item.key === message.key) && state.detail?.kind === 'object') {
            form = { section: state.detail.name, kind: 'object', key: message.key, valueType: message.suggested ?? 'string' }; baseline = ''; languageBaseline = {}; preview = ''; examples = []; render(); return;
        }
        const property = state.detail?.properties.find(item => item.key === key) ?? state.detail?.properties[0];
        if (property) { key = property.key; newForm(property); } else if (state.detail) { newForm(); }
        render();
    } else if (message.type === 'description' && message.section === form?.section && message.key === key && message.revision === state.revision) {
        languageBaseline = message.descriptions; preview = message.preview;
        if (!dirty()) { render(); }
    } else if (message.type === 'examples' && message.section === form?.section && message.key === key) {
        examples = message.examples.map((item: { id: string; path: string; section: string; key: string; value: string; line: number }) => ({ id: item.id, text: '[' + item.section + '] ' + item.key + '=' + item.value + '\n' + item.path + ':' + (item.line + 1) }));
        if (!dirty()) { render(); }
    } else if (message.type === 'applied') { form = undefined; baseline = ''; pending = false; latest = undefined;
    } else if (message.type === 'failure') {
        pending = false;
        if (state) { render(); error(message.error); }
        else { const display = node('p', message.error, 'dictionary-message'); display.setAttribute('role', 'alert'); host.replaceChildren(display); }
    }
});
post('ready');
