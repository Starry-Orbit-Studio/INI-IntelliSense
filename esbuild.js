const esbuild = require("esbuild");
const path = require('path');
const fs = require('fs').promises;

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * 一个 esbuild 插件，用于在构建结束后将非 TS/JS 资源（如i18n文件）复制到输出目录。
 * 这是确保 vscode-nls 能够找到语言包所必需的。
 * @type {import('esbuild').Plugin}
 */
const copyStaticFilesPlugin = {
    name: 'copy-static-files',
    setup(build) {
        build.onEnd(async () => {
            const outDir = build.initialOptions.outfile ? path.dirname(build.initialOptions.outfile) : 'dist';
            try {
                // 确保输出目录存在
                await fs.mkdir(outDir, { recursive: true });
                // 复制 i18n 目录
                await fs.cp('i18n', path.join(outDir, 'i18n'), { recursive: true });
                // 复制 assets 目录
                await fs.cp('assets', path.join(outDir, 'assets'), { recursive: true });
                console.log('[copy] i18n files copied successfully.');
            } catch (err) {
                console.error('Failed to copy static files:', err);
            }
        });
    },
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			copyStaticFilesPlugin,
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
