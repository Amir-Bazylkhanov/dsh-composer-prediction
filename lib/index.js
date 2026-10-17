// dsh-composer-predict — host half (Node).
//
// 1) Registers the user-settings namespace `composer-predict` (persisted to
//    <dsh home>/settings.yaml, hot-published to the browser by the host).
// 2) Owns the loopback RPC route /api/composer-predict/rpc:
//      config.get  — effective config
//      config.set  — merge-persist the namespace
//      predict     — one next-user-message prediction (chat completion proxy)
//      cancel      — abort an in-flight prediction by requestId
//
// All outbound model calls happen host-side: no browser CORS concerns and the
// API key never reaches page storage. The browser half never talks to a model
// provider directly, mirroring the split OpenCode #54197 uses (the plugin owns
// generation, the host owns the transport).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	CHANNEL,
	createHandler,
	isPlainObject,
	rpcError,
} from './handler.js'
import { DEFAULT_CONFIG, NS, ROUTE } from './shared.js'

/**
 * Config persistence.
 *
 * The 0.2.x settings service (`ctx.settings`) is a *form* service over loader
 * entries: `update(entryId, patch)` writes the profile patch, and there is no
 * `register(ns, schema)` returning a live `{get, update}` scope any more (that
 * was the 0.1.x API this plugin first targeted — calling it silently produced an
 * unusable scope, so every `config.set` threw and the toggle rolled back).
 *
 * Persisting our own small JSON document keeps the Settings page authoritative
 * and avoids coupling plugin config to the loader entry: one file, one merge.
 */
const configFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'composer-predict.json')

function readStoredConfig() {
	try {
		const parsed = JSON.parse(readFileSync(configFile(), 'utf8'))
		return isPlainObject(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

function writeStoredConfig(config) {
	const path = configFile()
	mkdirSync(dirname(path), { recursive: true })
	const temporary = `${path}.tmp`
	writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
	renameSync(temporary, path)
}

/** Cordis entry: config persistence + prediction route. */
function apply(ctx) {
	let stored = readStoredConfig()

	// The deployment default route (provider/model of a fresh agent). Optional:
	// compositions without it fall back to the plugin's explicit settings.
	let defaultSelection
	ctx.inject(['agentDefaultModel'], (modelCtx) => {
		defaultSelection = () => {
			try {
				return modelCtx.agentDefaultModel.currentSelection()
			} catch {
				return undefined
			}
		}
	})

	const connection = ctx.connection
	if (connection === undefined) return

	const getConfig = () => ({ ...DEFAULT_CONFIG, ...stored })
	const inflight = new Map()
	const handler = createHandler({
		getConfig,
		updateConfig: async (patch) => {
			stored = { ...stored, ...patch }
			writeStoredConfig(stored)
		},
		// Resolved lazily: the llm service may register after this plugin.
		get llm() {
			return ctx.llm
		},
		get defaultSelection() {
			return defaultSelection
		},
		inflight,
	})

	if (connection.fetch !== undefined) {
		ctx.effect(
			() =>
				connection.fetch.register({
					path: ROUTE,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: async (request) => {
						let endpoint = ''
						let payload = {}
						try {
							const parsed = await request.json()
							if (isPlainObject(parsed)) {
								endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : ''
								payload = parsed.payload
							}
						} catch {
							/* malformed body falls through to the unknown-endpoint error */
						}
						const result = await handler(endpoint, payload)
						return new Response(JSON.stringify(result), {
							status: 200,
							headers: { 'content-type': 'application/json' },
						})
					},
				}),
			'composer-predict: rpc route',
		)
		return
	}

	// Older runtimes without connection.fetch: register the legacy RPC channel.
	// That path needs webServer in the fiber, or registration throws.
	ctx.inject(['webServer'], (webCtx) => {
		const owner = webCtx.connection ?? connection
		if (typeof owner.rpc?.handle !== 'function') return
		ctx.effect(
			() => owner.rpc.handle(CHANNEL, handler, { authority: 'loopback' }),
			'composer-predict: rpc channel',
		)
	})
}

export { apply, NS, ROUTE, CHANNEL, DEFAULT_CONFIG, rpcError }
export default { apply }
