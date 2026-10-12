const assert = require('node:assert/strict');
const { chromium } = require('playwright');

/** Read-only acceptance on the real mod: prepare a change, then cancel it. */
module.exports = async function verifyPlatform(port, output, command) {
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
        await target.locator('.catalog-toolbar select').first().selectOption('game');
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
        await search.fill('ALTNK');
        await target.getByRole('checkbox', { name: 'ALTNK', exact: true }).waitFor();
        const names = await target.locator('.catalog-table tbody').textContent();
        assert.ok(!names.includes('_Amb_'));
        await target.locator('.catalog-table tbody td:nth-child(3) button').first().click();
        assert.equal(await search.inputValue(), 'ALTNK', 'preview keeps the catalogue and search in place');
        await target.locator('.toolbar button').first().click();
        await target.locator('.project-layout').waitFor();
        assert.ok((await target.locator('.project-root').textContent()).includes('Extreme Starry'));
        await target.page().screenshot({ path: output.replace('.png', '-overview.png') });
        if (command) {
            await command('ra2-project-workbench.focus');
            const page = target.page();
            const initialTree = page.getByRole('tree').filter({ hasText: /声音事件|Sound events/ });
            await initialTree.waitFor();
            // Native trees virtualize rows; identify the root once before scrolling its labels away.
            await initialTree.evaluate(element => element.setAttribute('data-project-qa', 'true'));
            const tree = page.locator('[data-project-qa=true]');
            assert.ok((await tree.textContent()).includes('Extreme Starry'));
            const game = tree.getByRole('treeitem').filter({ hasText: /单位、建筑与超武|Units, buildings and superweapons/ }).first();
            await page.screenshot({ path: output.replace('.png', '-sidebar-before.png') });
            await game.click();
            if (await game.getAttribute('aria-expanded') !== 'true') await game.press('ArrowRight');
            const vehicles = tree.getByRole('treeitem').filter({ hasText: /载具|Vehicles/ }).first();
            try { await vehicles.waitFor(); } catch(error) {
                console.error('Project tree:', await tree.textContent());
                await page.screenshot({ path: output.replace('.png', '-sidebar-failed.png') }); throw error;
            }
            await vehicles.click();
            if (await vehicles.getAttribute('aria-expanded') !== 'true') await vehicles.press('ArrowRight');
            await tree.getByRole('treeitem').filter({ hasText: /打开列表|Open list/ }).first().waitFor();
            await page.screenshot({ path: output.replace('.png', '-sidebar.png') });
            await command('ra2-ini-intellisense.projectOverview');
            await target.locator('.project-layout').waitFor();
            await target.locator('[data-project-tab=configuration]').click();
            await target.locator('[data-setting=\"project.entryPoints\"] input').first().waitFor();
            assert.ok(!(await target.locator('.project-configuration').textContent()).includes('旧设置'));
            await page.screenshot({ path: output.replace('.png', '-project-configuration.png') });
            await command('ra2-ini-intellisense.checkCenter');
            const findFrame = async (selector) => {
                for (let attempt = 0; attempt < 200; attempt++) {
                    for (const frame of page.frames()) {
                        if (await frame.locator(selector).count()) return frame;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error('Missing native analysis view: ' + selector);
            };
            const checks = await findFrame('[data-tab=rules]');
            await checks.locator('[data-tab=rules]').click();
            await checks.locator('.rule-row').first().waitFor();
            assert.equal(await checks.locator('.rule-row').count(), 18);
            await page.screenshot({ path: output.replace('.png', '-checks.png') });
            await checks.locator('.analysis-toolbar > button').nth(0).click();
            await checks.waitForFunction(() => document.querySelector('.analysis-status')?.textContent.includes('1/1'));
            await checks.locator('[data-tab=validator]').click();
            assert.equal(await checks.locator('[data-tab=settings]').count(), 0);
            await checks.locator('[data-setting=exePath]').waitFor();
            await page.screenshot({ path: output.replace('.png', '-settings.png') });
            await command('ra2-ini-intellisense.logicChain');
            const logic = await findFrame('.logic-focus');
            await logic.locator('form input[type=search]').fill('ALTNK');
            await logic.locator('form input[type=search]').press('Enter');
            try { await logic.getByRole('button', { name: 'ALTNK · VehicleType', exact: true }).click({ timeout: 5000 }); }
            catch (error) { console.error('Logic page:', await logic.locator('#app').textContent()); await page.screenshot({ path: output.replace('.png', '-logic-failed.png') }); throw error; }
            await logic.waitForFunction(() => document.querySelector('.logic-focus h2')?.textContent === 'ALTNK');
            assert.ok((await logic.locator('.logic-columns').textContent()).includes('Primary'));
            await page.screenshot({ path: output.replace('.png', '-logic.png') });
            await command('ra2-ini-intellisense.previewMap');
            let mapFrame;
            for (let attempt = 0; attempt < 100 && !mapFrame; attempt++) {
                for (const frame of page.frames()) {
                    if (await frame.locator('.map-viewport img').count()) { mapFrame = frame; break; }
                }
                if (!mapFrame) await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(mapFrame, 'native bottom panel renders the real ES map');
            await mapFrame.waitForFunction(() => document.querySelector('.map-viewport img')?.naturalWidth === 232);
            await page.screenshot({ path: output.replace('.png', '-map.png') });
        }

    } finally {
        await browser.close();
    }
};
