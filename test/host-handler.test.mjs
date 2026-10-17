// Host RPC surface: exercised with dependency injection and a stubbed fetch.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createHandler, resolveApiKey } from '../lib/handler.js'
import { DEFAULT_CONFIG, toApiMessages } from '../lib/shared.js'

const CONFIG = { ...DEFAULT_CONFIG, model: 'deepseek-flash', apiKey: 'sk-test', baseUrl: 'https://api.example/v1' }

const context = (overrides, extra) => {
	const state = { config: { ...CONFIG, ...overrides }, updates: [] }
	const handler = createHandler({
		getConfig: () => ({ ...state.config }),
		updateConfig: async (patch) => {
			state.updates.push(patch)
			state.config = { ...state.config, ...patch }
		},
		inflight: new Map(),
		...(extra ?? {}),
	})
	return { handler, state }
}

/** Minimal ctx.llm stand-in that streams a fixed answer and records controls. */
const fakeLlm = (answer = 'Run the tests.') => {
	const seen = []
	return {
		seen,
		llm: {
			async prepareCall(config, signal, configure) {
				seen.push({ config })
				const controls = configure({ ...config }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
				seen.push({ controls })
				return {
					config: { ...config, ...controls },
					async *stream(options) {
						seen.push({ options })
						for (const piece of answer.split(' ')) {
							yield { type: 'text-delta', index: 0, text: `${piece} ` }
						}
					},
				}
			},
		},
	}
}

const MESSAGES = [
	{ role: 'user', content: 'the parser drops empty lines' },
	{ role: 'assistant', content: 'Fixed in lib/parser.ts.' },
]

test('config.get returns the effective config', async () => {
	const { handler, state } = context()
	const result = await handler('config.get', {})
	assert.equal(result.ok, true)
	assert.equal(result.value.model, state.config.model)
})

test('config.set sanitizes the patch before persisting', async () => {
	const { handler, state } = context()
	const result = await handler('config.set', { maxTokens: 9000, delayMs: -1, bogus: true, enabled: false })
	assert.equal(result.ok, true)
	assert.deepEqual(state.updates, [{ maxTokens: 512, delayMs: 0, enabled: false }])
	assert.equal(result.value.enabled, false)
})

test('predict mirrors one normalized suggestion', async () => {
	const { handler } = context()
	let seen = null
	globalThis.fetch = async (url, init) => {
		seen = { url, body: JSON.parse(init.body), headers: init.headers }
		return { ok: true, json: async () => ({ choices: [{ message: { content: '"Add a regression test for empty input."' } }] }) }
	}
	const result = await handler('predict', { requestId: 'r1', messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.text, 'Add a regression test for empty input.')
	assert.equal(seen.url, 'https://api.example/v1/chat/completions')
	assert.equal(seen.headers.authorization, 'Bearer sk-test')
	assert.equal(seen.body.model, CONFIG.model)
	assert.equal(seen.body.stream, false)
	assert.equal(seen.body.messages.length, 2)
	assert.equal(seen.body.messages[0].role, 'system')
	assert.match(seen.body.messages[1].content, /Assistant: Fixed in lib\/parser\.ts\./)
})

test('predict never offers an explicit refusal or assistant voice', async () => {
	for (const content of ['NONE', 'Sure, I updated the parser.']) {
		const { handler } = context()
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
		const result = await handler('predict', { messages: MESSAGES })
		assert.equal(result.ok, true)
		assert.equal(result.value.text, '')
	}
})

test('predict without a model route or key fails loudly instead of silently', async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls += 1
		return { ok: true, json: async () => ({}) }
	}

	const noKey = context({ apiKey: '' })
	const saved = process.env.DEEPSEEK_API_KEY
	const savedHome = process.env.DSH_HOME
	process.env.DEEPSEEK_API_KEY = ''
	process.env.DSH_HOME = 'C:/definitely/not/here'
	const missing = await noKey.handler('predict', { messages: MESSAGES })
	if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = saved
	if (savedHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = savedHome
	assert.equal(missing.ok, false)
	assert.match(missing.error.message, /no model route/)

	const empty = await noKey.handler('predict', { messages: [] })
	assert.equal(empty.value.reason, 'empty-context')
	assert.equal(calls, 0)
})

test('predict rides ctx.llm with the deployment default route and least reasoning', async () => {
	const fake = fakeLlm('Run the integration tests.')
	const { handler } = context(
		{ apiKey: '', model: '', provider: '' },
		{ llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
	)
	globalThis.fetch = async () => {
		throw new Error('ctx.llm path must not call fetch')
	}

	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.text, 'Run the integration tests.')
	assert.equal(result.value.provider, 'deepseek-account')
	assert.equal(result.value.model, 'deepseek-flash')

	const controls = fake.seen.find((entry) => entry.controls !== undefined).controls
	assert.equal(controls.reasoningEffort, 'low', 'reasoning must be pinned to the cheapest effort')
	const options = fake.seen.find((entry) => entry.options !== undefined).options
	assert.equal(options.system.includes('predict the next message'), true)
	assert.equal(options.messages.length, 1)
	assert.equal(options.messages[0].content[0].type, 'text')
	assert.equal(options.maxTokens, 64)
})

test('explicit provider/model settings win over the deployment default', async () => {
	const fake = fakeLlm('Ship it.')
	const { handler } = context(
		{ provider: 'kimi-code', model: 'kimi-k2' },
		{ llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
	)
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.value.provider, 'kimi-code')
	assert.equal(result.value.model, 'kimi-k2')
})

test('predict is a no-op while the feature is disabled', async () => {
	const { handler } = context({ enabled: false })
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.reason, 'disabled')
})

test('provider failures surface as RPC errors, not suggestions', async () => {
	const { handler } = context()
	globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'internal')
	assert.match(result.error.message, /401/)
})

test('cancel aborts the matching in-flight prediction only', async () => {
	const { handler } = context()
	globalThis.fetch = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new Error('aborted')))
		})

	const unknown = await handler('cancel', { requestId: 'nope' })
	assert.deepEqual(unknown.value, { cancelled: false })

	const pending = handler('predict', { requestId: 'r9', messages: MESSAGES })
	await new Promise((resolve) => setTimeout(resolve, 10))
	const cancelled = await handler('cancel', { requestId: 'r9' })
	assert.deepEqual(cancelled.value, { cancelled: true })
	const result = await pending
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'cancelled')
})

test('unknown endpoints and malformed cancel are rejected', async () => {
	const { handler } = context()
	const unknown = await handler('nope', {})
	assert.equal(unknown.ok, false)
	const cancel = await handler('cancel', {})
	assert.equal(cancel.ok, false)
})

test('resolveApiKey prefers the setting, then the environment', () => {
	assert.equal(resolveApiKey({ apiKey: 'sk-config' }), 'sk-config')
	const saved = process.env.DEEPSEEK_API_KEY
	process.env.DEEPSEEK_API_KEY = 'sk-env'
	assert.equal(resolveApiKey({ apiKey: '' }), 'sk-env')
	if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = saved
})

test('the request the host sends is the one the shared builder describes', () => {
	const messages = toApiMessages(MESSAGES)
	assert.equal(messages.length, 2)
	assert.match(messages[1].content, /Write the user's next message/)
})
