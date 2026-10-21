// Generates market/index.json — the DSH plugin-market index that lists this
// package, so it can be added as an "index source" in Plugins → Discover.
//
// The icon is inlined as a base64 data URL and is taken from the same
// NAV_GLYPH_SVG constant the client bundle uses, so the two cannot drift.
//
// Run after every publish: `node scripts/build-market.mjs`
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const client = readFileSync(join(root, 'lib/client-body.js'), 'utf8')

const match = client.match(/const NAV_GLYPH_SVG =\s*\n?\s*'([^']+)'/)
if (match === null) throw new Error('build-market: NAV_GLYPH_SVG not found in lib/client-body.js')

const icon = `data:image/svg+xml;base64,${Buffer.from(match[1], 'utf8').toString('base64')}`
const author = String(pkg.author ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
const repositoryUrl = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')

// Keep the recorded publish time stable for an already-listed version, so a
// regeneration only changes the index when the version does (CI checks this).
let publishTimestamp = Math.floor(Date.now() / 1000)
try {
	const previous = JSON.parse(readFileSync(join(root, 'market/index.json'), 'utf8'))
	const listed = previous.plugins?.flatMap((plugin) => plugin.versions ?? []).find((entry) => entry.version === pkg.version)
	if (typeof listed?.publishTimestamp === 'number') publishTimestamp = listed.publishTimestamp
} catch {
	/* first generation, or an unreadable index: stamp now */
}

const index = {
	format: 1,
	title: { en: 'Amir Bazylkhanov plugins', zh: 'Amir Bazylkhanov 插件' },
	plugins: [
		{
			name: pkg.name,
			title: { en: 'Composer predictions', zh: '输入框预测' },
			description: {
				en: 'ChatGPT-style ghost-text suggestions for your next message in the DSH composer. Tab accepts, Esc dismisses. Not compatible with other composer ghost-text plugins.',
				zh: '在 DSH 输入框中用灰色 ghost 文本建议你的下一条消息。Tab 采纳，Esc 关闭。不要与其他输入框 ghost 文本插件同时安装。',
			},
			icon,
			author,
			homepage: pkg.homepage,
			repository: { url: repositoryUrl },
			versions: [
				{
					version: pkg.version,
					publishTimestamp,
					source: { type: 'npm' },
					...(pkg.engines?.dsh === undefined ? {} : { engines: { dsh: pkg.engines.dsh } }),
				},
			],
		},
	],
}

const out = join(root, 'market/index.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
process.stdout.write(`wrote ${out} (${pkg.name}@${pkg.version})\n`)
