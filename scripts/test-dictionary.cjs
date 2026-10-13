const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
    const labels = { title: '字典编辑器', search: '搜索 Tag、说明、类型或来源', types: '类型', tags: 'Tag', definition: '定义',
        apply: '应用修改', save: '保存并重载', discard: '放弃表单修改', newTag: '添加 Tag', newType: '添加类型', name: '名称', valueType: '值类型',
        default: '默认值', fileType: '文件用途', descriptions: '多语言说明', preview: '悬浮说明预览', changed: '字典已经变化',
        dirty: '未保存', clean: '已保存', syntax: '打开文本编辑器', copy: '创建项目副本', reload: '刷新', base: '父类型', range: '范围', pattern: '编号 Tag 使用 前缀(最小值,最大值)后缀 表达。', plainDescription: '可填写 Markdown；预览与悬浮说明共用内容。',
        enum: '允许的值', element: '元素类型', source: '来源', openSource: '打开来源', usages: '查看使用示例', local: '当前字典', inherited: '继承自' };
    const property = { key: 'Cost', type: 'int', defaultValue: '100', fileType: 'rules', owner: 'TechnoType', path: 'C:/Dictionary/Vanilla.ini', line: 5, inherited: true, local: false };
    const initial = { revision: '1', path: 'C:/Project/.ra2/INIDictionary.ini', dirty: false, protected: false,
        types: [{ name: 'UnitType', kind: 'object', count: 2 }, { name: 'AnimType', kind: 'object', count: 1 }, { name: 'Health', kind: 'number', count: 0 }],
        valueTypes: ['int', 'float', 'bool', 'string', 'UnitType', 'AnimType'], issues: [], labels,
        search: [{ section: 'UnitType', key: 'Cost', text: '造价 int' }, { section: 'AnimType', key: 'LoopCount', text: '循环次数' }],
        detail: { name: 'UnitType', kind: 'object', base: 'TechnoType', fields: {}, properties: [property, { ...property, key: 'Weapon(1,WeaponCount)FLH', type: 'CoordStruct' }] } };
    const errors = []; page.on('pageerror', error => errors.push(error));
    await page.setContent('<html><head></head><body><main id="dictionary"></main></body></html>');
    await page.addStyleTag({ content: `:root { --vscode-foreground:#d4d4d4; --vscode-editor-background:#1f1f1f; --vscode-descriptionForeground:#aaa; --vscode-font-family:Arial,sans-serif; --vscode-input-background:#313131; --vscode-input-foreground:#ddd; --vscode-input-border:#484848; --vscode-panel-border:#454545; --vscode-button-background:#0078d4; --vscode-button-foreground:#fff; --vscode-button-secondaryBackground:#333; --vscode-button-secondaryForeground:#ddd; --vscode-list-activeSelectionBackground:#094771; --vscode-list-activeSelectionForeground:#fff; --vscode-focusBorder:#0078d4; --vscode-textBlockQuote-background:#292929; }` });
    await page.addStyleTag({ path: path.resolve('dist/workbench/dictionary.css') });
    await page.evaluate(initial => {
        window.__state = initial; window.__messages = []; window.__attack = false;
        window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => {
            window.__messages.push(message);
            if (message.type === 'ready') { window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: window.__state } })); }
            if (message.type === 'description') { setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'description', key: message.key, section: 'UnitType', revision: message.revision, descriptions: { 'zh-CN': '单位的 **造价**。', 'en-US': 'Unit **cost**.' }, preview: '' } })), 0); }
        } });
    }, initial);
    await page.addScriptTag({ path: path.resolve('dist/workbench/dictionary.js') });
    await page.getByRole('heading', { name: '字典编辑器' }).waitFor();
    const description = page.locator('textarea'); await description.waitFor();
    assert.equal(await page.getByRole('button', { name: '应用修改', exact: true }).isDisabled(), true);
    await page.locator('.dictionary-description select').selectOption('zh-CN');
    await description.fill('**粗体**\n\n<script>window.__attack=true</script>\n<img src=x onerror="window.__attack=true">\n[bad](command:evil)');
    assert.equal(await page.locator('.dictionary-preview strong').textContent(), '粗体');
    assert.equal(await page.locator('.dictionary-preview script, .dictionary-preview img').count(), 0);
    assert.equal(await page.evaluate(() => window.__attack), false);
    assert.equal(await page.getByRole('button', { name: '应用修改', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '应用修改', exact: true }).click();
    const draft = await page.evaluate(() => window.__messages.filter(message => message.type === 'apply').at(-1).draft);
    assert.ok(draft.descriptions['zh-CN'].includes('粗体')); assert.equal(draft.descriptions['en-US'], undefined, 'Untouched translations must not be rewritten');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'failure', error: '冲突，请重新检查' } })));
    assert.ok((await description.inputValue()).includes('粗体'), 'Failures must retain the form');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: { ...window.__state, revision: '2' } } })));
    assert.ok((await description.inputValue()).includes('粗体'), 'External updates must retain the form');
    await page.getByRole('button', { name: '放弃表单修改' }).click();
    const search = page.getByRole('searchbox'); await search.fill('循环次数');
    assert.equal(await page.locator('.dictionary-type-list button').count(), 1);
    assert.equal(await page.locator('.dictionary-type-list button').textContent(), 'AnimType');
    await search.fill('');
    fs.mkdirSync('out/webview-qa', { recursive: true });
    await page.screenshot({ path: 'out/webview-qa/dictionary.png' });
    await page.setViewportSize({ width: 530, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: 'out/webview-qa/dictionary-narrow.png' });
    assert.deepEqual(errors, []); await browser.close(); console.log('Dictionary UI passed: authoring, Markdown safety, conflicts, search and responsive layout.');
}
main().catch(error => { console.error(error); process.exit(1); });
