// dsh-composer-predict — host request handling.
//
// Deliberately free of cordis/schemastery imports: this file is plain Node plus
// the shared pure helpers, so the whole RPC surface is unit testable without a
// host. lib/index.js owns the service wiring and injects `llm` /
// `defaultSelection` here.
//
// Two transport paths, in order of preference:
//   1. the harness LLM service (`ctx.llm`) — uses the deployment's configured
//      provider route and credentials, so no separate API key is needed;
//   2. a direct OpenAI-compatible HTTP call — only for compositions without an
//      LLM service.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	CHANNEL,
	DEFAULT_CONFIG,
	NS,
	ROUTE,
	buildPrompt,
	clampFloat,
	clampNumber,
	normalizeSuggestion,
	sanitizeConfigPatch,
} from './shared.js'

/** RPC error codes must live in the transport enum (bad-request/cancelled/internal). */
export const rpcError = (message) => ({
	ok: false,
	error: { code: 'internal', message, details: {} },
})
export const rpcCancelled = () => ({
	ok: false,
	error: { code: 'cancelled', message: 'prediction cancelled by client', details: {} },
})
export const rpcValue = (value) => ({ ok: true, value })

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Resolve the DeepSeek API key for the direct-HTTP fallback: plugin setting,
 * then DEEPSEEK_API_KEY, then the credential document dsh already keeps.
 */
export function resolveApiKey(config) {
	if (typeof config.apiKey === 'string' && config.apiKey !== '') return config.apiKey
	if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') {
		return process.env.DEEPSEEK_API_KEY
	}
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
		const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
		const match = doc.match(/^\s*DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
		if (match !== null) return match[1]
	} catch {
		/* no credential document: fall through to the empty key */
	}
	return ''
}

const trimBaseUrl = (baseUrl) => String(baseUrl).replace(/\/+$/, '')

/**
 * Call an OpenAI-compatible chat endpoint and return the raw assistant text.
 * Only used when no harness LLM service is composed.
 */
export async function requestPrediction(options) {
	const url = `${trimBaseUrl(options.baseUrl)}/chat/completions`
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({
			model: options.model,
			messages: options.messages,
			max_tokens: options.maxTokens,
			temperature: options.temperature,
			stream: false,
		}),
		signal: options.signal,
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => '')
		throw new Error(`provider HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`)
	}
	const payload = await response.json()
	const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined
	const content = choice?.message?.content
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content
			.map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
			.join('')
	}
	return ''
}

/**
 * Pick the model route: explicit settings win, then the deployment default that
 * fresh agents start on. `null` means "no harness route available".
 */
export function resolveRoute(config, fallbackSelection) {
	if (
		typeof config.provider === 'string' &&
		config.provider !== '' &&
		typeof config.model === 'string' &&
		config.model !== ''
	) {
		return { provider: config.provider, model: config.model }
	}
	const fallback = typeof fallbackSelection === 'function' ? fallbackSelection() : undefined
	if (fallback !== null && fallback !== undefined && typeof fallback.provider === 'string') {
		return { provider: fallback.provider, model: fallback.model }
	}
	return null
}

/**
 * Build the RPC handler. Pure dependency injection so unit tests can drive every
 * endpoint without a cordis context.
 *
 * @param deps.getConfig        effective config
 * @param deps.updateConfig     merge-persist
 * @param deps.llm              optional `ctx.llm` (harness model service)
 * @param deps.defaultSelection optional `() => { provider, model } | undefined`
 * @param deps.inflight         shared abort registry
 */
export function createHandler(deps) {
	const inflight = deps.inflight ?? new Map()
	return async function handler(endpoint, payload) {
		if (endpoint === 'config.get') return rpcValue(deps.getConfig())

		if (endpoint === 'config.set') {
			const patch = sanitizeConfigPatch(payload)
			try {
				await deps.updateConfig(patch)
			} catch (error) {
				return rpcError(error instanceof Error ? error.message : String(error))
			}
			return rpcValue(deps.getConfig())
		}

		if (endpoint === 'cancel') {
			const body = isPlainObject(payload) ? payload : {}
			const requestId = typeof body.requestId === 'string' ? body.requestId : ''
			if (requestId === '') return rpcError('cancel: requestId required')
			const controller = inflight.get(requestId)
			if (controller !== undefined) controller.abort()
			return rpcValue({ cancelled: controller !== undefined })
		}

		if (endpoint === 'predict') return predict(deps, inflight, payload)

		return rpcError(`unknown endpoint ${String(endpoint)}`)
	}
}

/** Shared setup: validate the payload and build the model-visible prompt. */
function prepare(deps, payload) {
	const config = deps.getConfig()
	if (config.enabled === false) return { config, skip: 'disabled' }

	const body = isPlainObject(payload) ? payload : {}
	const messages = Array.isArray(body.messages) ? body.messages : []
	const tail = messages
		.filter((message) => isPlainObject(message))
		.map((message) => ({
			role: message.role === 'assistant' ? 'assistant' : 'user',
			content: typeof message.content === 'string' ? message.content.slice(0, 20000) : '',
		}))
		.filter((message) => message.content.trim() !== '')
	if (tail.length === 0) return { config, skip: 'empty-context' }

	return { config, prompt: buildPrompt(tail), tail }
}

async function predict(deps, inflight, payload) {
	const { config, skip, prompt } = prepare(deps, payload)
	if (skip !== undefined) return rpcValue({ text: '', reason: skip })

	const route = resolveRoute(config, deps.defaultSelection)
	const requestId = isPlainObject(payload) && typeof payload.requestId === 'string' ? payload.requestId : ''
	const controller = new AbortController()
	if (requestId !== '') inflight.set(requestId, controller)
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, 20000)
	const started = Date.now()
	try {
		const raw =
			deps.llm !== undefined && route !== null
				? await streamHarnessPrediction(deps.llm, route, config, prompt, controller.signal)
				: await requestPredictionFallback(config, prompt, controller.signal)
		const text = normalizeSuggestion(raw, { maxChars: config.maxSuggestionChars })
		return rpcValue({
			text,
			model: route?.model ?? config.model,
			provider: route?.provider,
			ms: Date.now() - started,
		})
	} catch (error) {
		if (timedOut) return rpcError('prediction timed out after 20s')
		if (controller.signal.aborted) return rpcCancelled()
		return rpcError(error instanceof Error ? error.message : String(error))
	} finally {
		clearTimeout(timeout)
		if (requestId !== '') inflight.delete(requestId)
	}
}

/**
 * One call through the harness LLM service. Reasoning is pinned to the model's
 * cheapest advertised effort: a next-message guess does not need a thinking
 * budget, and a reasoning model would otherwise spend seconds and tokens before
 * emitting any text.
 */
async function streamHarnessPrediction(llm, route, config, prompt, signal) {
	const messages = [{ role: 'user', content: [{ type: 'text', text: prompt.input }] }]
	const maxTokens = clampNumber(config.maxTokens, 8, 512, DEFAULT_CONFIG.maxTokens)
	let text = ''

	if (typeof llm.prepareCall === 'function') {
		const prepared = await llm.prepareCall({ ...route, maxTokens }, signal, (controls, model) => {
			const effort = model?.reasoning?.efforts?.[0]
			return effort === undefined ? controls : { ...controls, reasoningEffort: effort.id }
		})
		for await (const chunk of prepared.stream({ ...prepared.config, system: prompt.system, messages, signal })) {
			if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
		}
		return text
	}

	for await (const chunk of llm.stream({ ...route, maxTokens, system: prompt.system, messages, signal })) {
		if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
	}
	return text
}

/** Direct HTTP path: only for compositions with no LLM service. */
async function requestPredictionFallback(config, prompt, signal) {
	const apiKey = resolveApiKey(config)
	if (apiKey === '') throw new Error('no model route: ctx.llm is absent and no DEEPSEEK_API_KEY is configured')
	const model = config.model !== '' ? config.model : 'deepseek-flash'
	return requestPrediction({
		baseUrl: config.baseUrl,
		apiKey,
		model,
		maxTokens: clampNumber(config.maxTokens, 8, 512, DEFAULT_CONFIG.maxTokens),
		temperature: clampFloat(config.temperature, 0, 2, DEFAULT_CONFIG.temperature),
		messages: [
			{ role: 'system', content: prompt.system },
			{ role: 'user', content: prompt.input },
		],
		signal,
	})
}

export { CHANNEL, NS, ROUTE }
