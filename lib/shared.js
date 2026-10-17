// dsh-composer-predict — shared pure logic.
//
// Imported by the host half (lib/index.js, real ESM) and inlined into the
// browser bundle by scripts/build-client.mjs (which strips `export ` keywords,
// so this file must contain nothing but plain declarations + exports).
//
// Nothing here touches Node, the DOM, or React: it is safe in both worlds and
// unit-testable on its own.

/** Settings namespace (also the settings-card key) and RPC identities. */
export const NS = 'composer-predict'
export const ROUTE = '/api/composer-predict/rpc'
export const CHANNEL = '/composer-predict'

/** Config defaults, mirrored by the host schemastery schema. */
export const DEFAULT_CONFIG = {
	enabled: true,
	/**
	 * Model route. Empty means "use the deployment default that fresh agents
	 * start on" (ctx.agentDefaultModel), which is what a normal install wants:
	 * the plugin then rides the same provider and credentials as the session.
	 */
	provider: '',
	model: '',
	/** Direct-HTTP fallback only: used when no harness LLM service is composed. */
	baseUrl: 'https://api.deepseek.com',
	apiKey: '',
	maxTokens: 64,
	temperature: 0.8,
	/** Ask as soon as the turn ends; typing still cancels the request. */
	delayMs: 0,
	/** Hard cap for the offered suggestion; longer answers are truncated. */
	maxSuggestionChars: 200,
	/** How many trailing conversation messages feed the predictor. */
	contextMessages: 10,
	/** Character budget for the transcript block. */
	maxContextChars: 6000,
}

/** Coerce to a finite integer inside [min, max], or the fallback. */
export function clampNumber(value, min, max, fallback) {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}

/** Coerce to a finite float inside [min, max], or the fallback. */
export function clampFloat(value, min, max, fallback) {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, n))
}

/** Join the text blocks of a user/assistant node, ignoring tool and image parts. */
export function textOfBlocks(blocks) {
	if (!Array.isArray(blocks)) return ''
	const parts = []
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue
		if (block.kind === 'text' && typeof block.text === 'string') parts.push(block.text)
	}
	return parts.join('\n')
}

/**
 * Extract a chronological tail of the conversation from Chat nodes.
 * User, steering and assistant nodes participate; tool results, context
 * injections, compaction markers and commands are noise for prediction.
 *
 * @param nodes  `useChat(snapshot => snapshot.legacy.nodes)`
 * @param options `{ limit, maxChars }`
 * @returns `[{ role: 'user' | 'assistant', content: string }]`
 */
export function extractTail(nodes, options) {
	const opts = options ?? {}
	const limit = clampNumber(opts.limit, 1, 40, DEFAULT_CONFIG.contextMessages)
	const maxChars = clampNumber(opts.maxChars, 200, 100000, DEFAULT_CONFIG.maxContextChars)
	const list = Array.isArray(nodes) ? nodes : []
	const out = []
	let chars = 0
	for (let i = list.length - 1; i >= 0 && out.length < limit; i -= 1) {
		const node = list[i]
		if (node === null || typeof node !== 'object') continue
		let role = ''
		let text = ''
		if (node.kind === 'user' || node.kind === 'steering') {
			role = 'user'
			text = textOfBlocks(node.content)
		} else if (node.kind === 'assistant') {
			role = 'assistant'
			text = textOfBlocks(node.blocks)
		} else {
			continue
		}
		text = text.trim()
		if (text === '') continue
		const room = maxChars - chars
		if (room < 40) break
		if (text.length > room) text = text.slice(text.length - room)
		out.unshift({ role, content: text })
		chars += text.length
	}
	return out
}

/** Seq of the newest assistant node, or 0 — the identity of one finished turn. */
export function lastAssistantSeq(nodes) {
	const list = Array.isArray(nodes) ? nodes : []
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const node = list[i]
		if (node !== null && typeof node === 'object' && node.kind === 'assistant') {
			return typeof node.seq === 'number' ? node.seq : 0
		}
	}
	return 0
}

const QUOTE_PAIRS = [
	['"', '"'],
	["'", "'"],
	['\u201c', '\u201d'],
	['\u300c', '\u300d'],
	['`', '`'],
]

/**
 * Turn raw model output into something worth showing in a composer, or ''.
 * Mirrors the contract of OpenCode #54197: a suggestion is a single, short,
 * user-voiced line, or nothing at all.
 */
export function normalizeSuggestion(raw, options) {
	const opts = options ?? {}
	const maxChars = clampNumber(opts.maxChars, 20, 2000, DEFAULT_CONFIG.maxSuggestionChars)
	if (typeof raw !== 'string') return ''
	let text = raw.replace(/\r/g, '').trim()
	if (text === '') return ''

	// A fenced block is never a composer suggestion; take its first line.
	text = text.replace(/^```[A-Za-z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim()

	// Suggestions are one line: the first non-empty one wins.
	const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
	if (lines.length === 0) return ''
	text = lines[0]

	// Drop speaker labels the model may have echoed back.
	text = text.replace(/^(?:next|user|you|suggestion|prediction)\s*[:\uff1a]\s*/i, '')

	// Strip wrapping quotes, repeatedly (nested quoting is common).
	let stripped = true
	while (stripped) {
		stripped = false
		for (const pair of QUOTE_PAIRS) {
			if (text.length > 1 && text.startsWith(pair[0]) && text.endsWith(pair[1])) {
				text = text.slice(1, -1).trim()
				stripped = true
			}
		}
	}

	text = text.replace(/\s+/g, ' ').trim()
	if (text === '') return ''

	// Explicit refusal.
	if (/^none[.!]?$/i.test(text)) return ''

	// Assistant-voiced openers are a prediction failure, not a suggestion.
	if (/^(?:sure|certainly|of course|here(?:'s| is)|i(?:'ve| have) (?:updated|fixed|added))\b/i.test(text)) return ''

	if (text.length > maxChars) {
		text = text.slice(0, maxChars)
		const cut = text.lastIndexOf(' ')
		if (cut > maxChars * 0.6) text = text.slice(0, cut)
		text = text.replace(/[\s,;:.!?\u2026-]+$/, '')
	}
	return text
}

/** The system prompt that turns a chat model into a next-user-message predictor. */
export function buildSystemPrompt() {
	return [
		'You predict the next message a user will send to a coding assistant.',
		'You see the recent conversation. Write the single most likely next user message from the user\'s point of view.',
		'Rules:',
		'- Reply with the message text only: no quotes, no markdown, no preamble, no explanation.',
		'- One line, at most 20 words.',
		'- Write in the dominant language of the conversation (if the user wrote in English, reply in English; never switch languages on your own).',
		'- It must be something actionable the user would plausibly type right now (a follow-up, a fix request, a review ask, an approval).',
		'- Never answer as the assistant and never continue the assistant\'s work yourself.',
		'- If no useful prediction is possible, reply exactly NONE.',
	].join('\n')
}

/**
 * Build the model-visible prompt once, for both transports.
 * `system` is the predictor instruction; `input` is the transcript framed as a
 * single user turn (a trailing assistant turn would make the model continue as
 * the assistant instead of writing the user's next message).
 */
export function buildPrompt(tail) {
	const messages = Array.isArray(tail) ? tail : []
	if (messages.length === 0) return { system: buildSystemPrompt(), input: '' }
	const transcript = messages
		.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
		.join('\n\n')
	return {
		system: buildSystemPrompt(),
		input: `Conversation so far:\n\n${transcript}\n\nWrite the user's next message. Reply with the message only.`,
	}
}

/** Build chat messages for the direct-HTTP transport. */
export function toApiMessages(tail) {
	const prompt = buildPrompt(tail)
	if (prompt.input === '') return []
	return [
		{ role: 'system', content: prompt.system },
		{ role: 'user', content: prompt.input },
	]
}

/** Sanitize an untrusted config pickle from the browser before persisting it. */
export function sanitizeConfigPatch(patch) {
	const out = {}
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
	const put = (key, value) => {
		out[key] = value
	}
	if (typeof patch.enabled === 'boolean') put('enabled', patch.enabled)
	if (typeof patch.provider === 'string') put('provider', patch.provider.trim().slice(0, 120))
	if (typeof patch.baseUrl === 'string') put('baseUrl', patch.baseUrl.trim().slice(0, 400))
	if (typeof patch.apiKey === 'string') put('apiKey', patch.apiKey.trim().slice(0, 400))
	if (typeof patch.model === 'string') put('model', patch.model.trim().slice(0, 120))
	if (patch.maxTokens !== undefined) put('maxTokens', clampNumber(patch.maxTokens, 8, 512, DEFAULT_CONFIG.maxTokens))
	if (patch.temperature !== undefined) put('temperature', clampFloat(patch.temperature, 0, 2, DEFAULT_CONFIG.temperature))
	if (patch.delayMs !== undefined) put('delayMs', clampNumber(patch.delayMs, 0, 30000, DEFAULT_CONFIG.delayMs))
	if (patch.maxSuggestionChars !== undefined) {
		put('maxSuggestionChars', clampNumber(patch.maxSuggestionChars, 20, 2000, DEFAULT_CONFIG.maxSuggestionChars))
	}
	if (patch.contextMessages !== undefined) {
		put('contextMessages', clampNumber(patch.contextMessages, 1, 40, DEFAULT_CONFIG.contextMessages))
	}
	if (patch.maxContextChars !== undefined) {
		put('maxContextChars', clampNumber(patch.maxContextChars, 200, 100000, DEFAULT_CONFIG.maxContextChars))
	}
	return out
}
