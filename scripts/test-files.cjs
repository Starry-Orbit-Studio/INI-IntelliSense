const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1450, height: 850 } }), errors = [];
        page.on('pageerror', error => errors.push(error));
        const bundle = JSON.parse(fs.readFileSync('i18n/bundle.nls.zh-cn.json', 'utf8'));
        const labels = Object.fromEntries(Object.entries(bundle).filter(([key]) => key.startsWith('mix.browser.')).map(([key, value]) => [key.slice(12), value]));
        const rows = Array.from({ length: 12000 }, (_, index) => ({ token: 'file-' + index, name: 'asset' + String(index).padStart(5, '0') + '.shp', size: index + 10, directory: false, archive: false }));
        rows[0] = { ...rows[0], name: 'nested.mix', archive: true }; rows[1] = { ...rows[1], name: 'folder', directory: true };
        rows[2] = { ...rows[2], name: '<img src=x onerror=alert(1)>.ini' };
        const initial = { panes: [{ location: 'left', label: 'C:\\Project\\resources', parent: 'parent', crumbs: [{ token: 'parent', label: 'Project' }, { token: 'left', label: 'resources' }], rows, readonly: false, archive: false }, { location: 'right', label: 'C:\\Project\\test.mix', parent: 'parent', crumbs: [{ token: 'right', label: 'test.mix' }], rows: [], readonly: false, archive: true }], labels, clipboard: 0, cut: false, undo: false, busy: false };
        await page.setContent('<html><body><main id="files"></main></body></html>');
        await page.addStyleTag({ path: path.resolve('dist/workbench/files.css') });
        await page.evaluate(initial => {
            window.__state = initial; window.__messages = [];
            window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => {
                window.__messages.push(message);
                if (message.type === 'ready') { window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: window.__state } })); }
                if (message.type === 'clipboard') { window.__state = { ...window.__state, clipboard: message.tokens.length, cut: message.cut }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: window.__state } })); }
                if (message.type === 'preview') { window.dispatchEvent(new MessageEvent('message', { data: { type: 'preview', token: message.token, name: 'Safe <name>', text: '<script>attack()</script>' } })); }
            } });
        }, initial);
        await page.addScriptTag({ path: path.resolve('dist/workbench/files.js') });
        const left = page.locator('[data-pane="0"]'), right = page.locator('[data-pane="1"]');
        await left.locator('.file-row').first().waitFor();
        assert.ok(await page.locator('.file-row').count() < 100, '12,000 entries are virtualized');
        assert.equal(await page.locator('.file-row script, .file-row img').count(), 0, 'Names are rendered as text');
        await left.locator('.file-row').nth(3).click();
        await left.locator('.file-row').nth(5).click({ modifiers: ['Shift'] });
        assert.ok((await left.locator('.pane-info').textContent()).includes('3 个已选'));
        await page.keyboard.press('Control+c');
        assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'clipboard').at(-1).tokens.length), 3);
        await right.locator('.file-scroll').click(); await page.keyboard.press('Control+v');
        assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'paste').at(-1).pane), 1);
        await left.locator('input[type=search]').fill('asset11999');
        assert.equal(await left.locator('.file-row').count(), 1);
        await left.locator('.file-row').click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
        assert.deepEqual(await page.evaluate(() => window.__messages.filter(message => message.type === 'clipboard').at(-1).tokens), ['file-11999']);
        await left.locator('input[type=search]').fill('');
        await left.locator('.file-scroll').evaluate(element => element.scrollTop = 200000);
        await page.waitForTimeout(100);
        assert.ok((await left.locator('.file-row').first().getAttribute('data-index')) > 5000, 'Scroll renders distant rows');
        await left.locator('.file-scroll').evaluate(element => element.scrollTop = 0); await page.waitForTimeout(100);
        await left.locator('input[type=search]').fill('nested.mix'); await left.locator('.file-row').dblclick();
        assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'navigate').at(-1).token), 'file-0');
        await left.locator('input[type=search]').fill('asset00003'); await left.locator('.file-row').click(); await page.waitForTimeout(250);
        assert.ok((await page.locator('.file-preview pre').textContent()).includes('<script>'));
        assert.equal(await page.locator('.file-preview script').count(), 0);
        await left.locator('input[type=search]').fill('');
        await left.locator('.file-scroll').evaluate(element => element.scrollTop = 0); await page.waitForTimeout(100);
        const box = await left.locator('.file-scroll').boundingBox();
        await page.mouse.move(box.x + box.width - 40, box.y + 4 * 34 + 17); await page.mouse.down();
        await page.mouse.move(box.x + box.width - 90, box.y + 8 * 34 + 17, { steps: 10 }); await page.mouse.up();
        assert.ok((await left.locator('.pane-info').textContent()).includes('5 个已选'), 'Lasso works in a long virtualized list: ' + await left.locator('.pane-info').textContent());
        await left.locator('.file-row').nth(3).click(); await left.locator('.file-row').nth(5).click({ modifiers: ['Shift'] });
        await left.locator('.file-row.selected').first().dragTo(right.locator('.file-scroll'));
        assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'transfer').at(-1)?.tokens.length), 3, 'Multi-selection drag sends all rows');
        await page.evaluate(() => { window.__state = { ...window.__state, busy: true }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: window.__state } })); });
        assert.equal(await page.locator('.toolbar button[data-label="copy"]').isDisabled(), true);
        assert.equal(await page.locator('.toolbar button[data-label="cancel"]').isEnabled(), true);
        await page.evaluate(() => { window.__state = { ...window.__state, busy: false }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: window.__state } })); });
        fs.mkdirSync('out/webview-qa', { recursive: true }); await page.screenshot({ path: 'out/webview-qa/files.png' });
        await page.setViewportSize({ width: 740, height: 720 }); await page.screenshot({ path: 'out/webview-qa/files-narrow.png' });
        assert.deepEqual(errors, []);
        console.log('Files browser: virtualization, selection, keyboard, filtering, drag/drop, preview isolation and responsive layouts passed.');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
