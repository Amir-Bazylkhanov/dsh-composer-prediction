import assert from 'node:assert/strict'
import test from 'node:test'

import {
	DEFAULT_CONFIG,
	clampFloat,
	clampNumber,
	extractTail,
	lastAssistantSeq,
	normalizeSuggestion,
	sanitizeConfigPatch,
	toApiMessages,
} from '../lib/shared.js'

const user = (text, seq = 1) => ({ kind: 'user', seq, content: [{ kind: 'text', text }] })
const assistant = (text, seq = 2) => ({ kind: 'assistant', seq, blocks: [{ kind: 'text', text }] })

test('normalizeSuggestion strips quoting and speaker labels', () => {
	assert.equal(normalizeSuggestion('"Add a regression test for this fix."'), 'Add a regression test for this fix.')
	assert.equal(normalizeSuggestion('Next: run the suite'), 'run the suite')
	assert.equal(normalizeSuggestion('`fix the flaky test`'), 'fix the flaky test')
	assert.equal(normalizeSuggestion('\u201cCan you also update the docs?\u201d'), 'Can you also update the docs?')
})

test('normalizeSuggestion keeps only the first non-empty line', () => {
	assert.equal(normalizeSuggestion('\n\n  ship it  \nand then some'), 'ship it')
})

test('normalizeSuggestion refuses explicit non-answers and assistant voice', () => {
	assert.equal(normalizeSuggestion('NONE'), '')
	assert.equal(normalizeSuggestion('none.'), '')
	assert.equal(normalizeSuggestion('Sure, I can do that'), '')
	assert.equal(normalizeSuggestion("Here's the updated file"), '')
	assert.equal(normalizeSuggestion('   '), '')
	assert.equal(normalizeSuggestion(null), '')
})

test('normalizeSuggestion truncates on a word boundary', () => {
	const long = 'please '.repeat(60).trim()
	const out = normalizeSuggestion(long, { maxChars: 40 })
	assert.ok(out.length <= 40)
	assert.ok(!out.endsWith(' '))
	assert.ok(!out.endsWith(','))
})

test('extractTail keeps chronological user/assistant turns and drops noise', () => {
	const nodes = [
		user('first question', 1),
		assistant('first answer', 2),
		{ kind: 'tool-result', seq: 3 },
		{ kind: 'context', seq: 4, content: [{ kind: 'text', text: 'system noise' }] },
		user('second question', 5),
		assistant('second answer', 6),
	]
	assert.deepEqual(extractTail(nodes), [
		{ role: 'user', content: 'first question' },
		{ role: 'assistant', content: 'first answer' },
		{ role: 'user', content: 'second question' },
		{ role: 'assistant', content: 'second answer' },
	])
})

test('extractTail honours the message limit and the character budget', () => {
	const nodes = [user('a'.repeat(500), 1), assistant('b'.repeat(500), 2), user('recent', 3)]
	const limited = extractTail(nodes, { limit: 2 })
	assert.equal(limited.length, 2)
	assert.equal(limited[1].content, 'recent')

	const budgeted = extractTail(nodes, { limit: 10, maxChars: 600 })
	const total = budgeted.reduce((sum, message) => sum + message.content.length, 0)
	assert.ok(total <= 600)
})

test('extractTail joins only text blocks', () => {
	const node = {
		kind: 'assistant',
		seq: 9,
		blocks: [
			{ kind: 'reasoning', text: 'thinking' },
			{ kind: 'text', text: 'answer' },
			{ kind: 'tool-call', callId: 'x', name: 'read', argsRaw: '{}' },
		],
	}
	assert.deepEqual(extractTail([node]), [{ role: 'assistant', content: 'answer' }])
})

test('lastAssistantSeq finds the newest answer', () => {
	assert.equal(lastAssistantSeq([user('q', 1), assistant('a', 2), user('q2', 3)]), 2)
	assert.equal(lastAssistantSeq([user('q', 1)]), 0)
	assert.equal(lastAssistantSeq(null), 0)
})

test('toApiMessages asks the model for the next user message', () => {
	const messages = toApiMessages([{ role: 'user', content: 'fix the bug' }, { role: 'assistant', content: 'fixed' }])
	assert.equal(messages.length, 2)
	assert.equal(messages[0].role, 'system')
	assert.match(messages[0].content, /next user message/i)
	assert.equal(messages[1].role, 'user')
	assert.match(messages[1].content, /User: fix the bug/)
	assert.match(messages[1].content, /Assistant: fixed/)
	assert.match(messages[1].content, /Write the user's next message/)
})

test('toApiMessages rejects empty context', () => {
	assert.deepEqual(toApiMessages([]), [])
})

test('sanitizeConfigPatch clamps and drops unknown or mistyped values', () => {
	const patch = sanitizeConfigPatch({
		enabled: 'yes',
		model: '  deepseek-reasoner  ',
		maxTokens: 9999,
		delayMs: -5,
		temperature: 9,
		unknown: 'dropped',
		apiKey: 42,
	})
	assert.deepEqual(patch, {
		model: 'deepseek-reasoner',
		maxTokens: 512,
		delayMs: 0,
		temperature: 2,
	})
})

test('clamp helpers fall back on non-finite input', () => {
	assert.equal(clampNumber('abc', 0, 10, 7), 7)
	assert.equal(clampNumber(12.6, 0, 10, 7), 10)
	assert.equal(clampFloat(0.25, 0, 2, 1), 0.25)
	assert.equal(clampFloat(undefined, 0, 2, 1), 1)
})
