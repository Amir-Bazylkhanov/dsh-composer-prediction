// Runs every test file in one process.
//
// `node --test test/` spawns a child per file, which some sandboxes deny
// (EPERM on spawn). Importing the files keeps the same node:test reporter and
// assertions without any subprocess.

const files = ['shared.test.mjs', 'host-handler.test.mjs', 'client-bundle.test.mjs']

for (const file of files) {
	await import(new URL(`../test/${file}`, import.meta.url).href)
}
