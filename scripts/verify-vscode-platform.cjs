const assert = require('node:assert/strict');
const { chromium } = require('playwright');

/** Read-only acceptance on the real mod: prepare a change, then cancel it. */
module.exports = async function verifyPlatform(port, output) {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    try {
        let target;
        for (let attempt = 0; attempt < 100 && !target; attempt++) {
            for (const page of browser.contexts().flatMap((context) => context.pages())) {
                for (const frame of page.frames()) {
                    if (await frame.locator('.catalog-table').count()) {
                        target = frame;
                        break;
                    }
                }
            }
            if (!target) await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.ok(target, 'native project browser renders');
        await target.locator('.catalog-toolbar select').first().selectOption('rules');
        const search = target.locator('.catalog-toolbar input[type=search]');
        await search.fill('ALTNK');
        await target.getByRole('checkbox', { name: 'ALTNK', exact: true }).check();
        await search.fill('ALTANY');
        await target.getByRole('checkbox', { name: 'ALTANY', exact: true }).check();
        const toolbarButtons = target.locator('.catalog-toolbar > button');
        await toolbarButtons.nth(0).click();
        await target.locator('.object-comparison:not([hidden]) table').waitFor();
        assert.ok((await target.locator('.object-comparison').textContent()).includes('ALTNK'));
        assert.ok((await target.locator('.object-comparison').textContent()).includes('ALTANY'));
        await toolbarButtons.nth(1).click();
        const form = target.locator('.batch-form');
        await form.locator('input').nth(0).fill('Cost');
        await form.locator('select').selectOption('add');
        await form.locator('input').nth(1).fill('10');
        await form.locator('button[type=submit]').click();
        try {
            await target.locator('.change-preview table').waitFor({ timeout: 10000 });
        } catch (error) {
            console.error('Batch preview status:', await target.locator('#status').textContent());
            console.error(
                'Resolution context:',
                (await target.locator('.resolution-context').textContent()).slice(0, 1800)
            );
            await target.page().screenshot({ path: output.replace('.png', '-failed.png') });
            throw error;
        }
        assert.equal(await target.locator('.change-preview table tr').count(), 2);
        await target.page().screenshot({ path: output });
        // The second button cancels. Never apply changes to the real project.
        await target.locator('.change-preview > button').nth(1).click();
        assert.equal(await target.locator('.change-preview table').count(), 0);
    } finally {
        await browser.close();
    }
};
