// Loads the generated ModuleLoader bundle in a VM with a fake browser and a
// fake React, then drives apply(): this catches wiring mistakes (slot names,
// registration meta, locale, keydown install) without a real browser.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { NAV_GLYPH_CSS, findNavButton } from '../lib/client-body.js'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadBundle() {
	let definition = null
	const listeners = []
	const document = {
		addEventListener: (type, handler) => listeners.push({ type, handler }),
		removeEventListener: () => {},
	}
	const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
	window.document = document
	class FakeHTMLElement {}
	class FakeTextArea extends FakeHTMLElement {}
	const sandbox = {
		window,
		document,
		fetch: async () => ({ status: 500, json: async () => ({}) }),
		setTimeout,
		clearTimeout,
		console,
		HTMLElement: FakeHTMLElement,
		HTMLTextAreaElement: FakeTextArea,
	}
	vm.createContext(sandbox)
	vm.runInContext(SOURCE, sandbox)
	assert.ok(definition !== null, 'bundle never called __ModuleLoader__.load')
	return { definition, window, listeners, FakeHTMLElement }
}

const noop = () => {}
const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useEffect: noop,
	useLayoutEffect: noop,
	useRef: (value) => ({ current: value }),
	useState: (value) => [typeof value === 'function' ? value() : value, noop],
}

function fakeRequire(id) {
	if (id === 'react') return fakeReact
	throw new Error(`unexpected require(${id})`)
}

test('bundle exposes the expected id and plugin shape', () => {
	const { definition } = loadBundle()
	assert.equal(definition.id, 'dsh-composer-prediction')
	const plugin = definition.factory(fakeRequire)
	assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'connection'])
	assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the overlay, the settings card, the locale and the key handler', () => {
	const { definition, window, listeners } = loadBundle()
	const plugin = definition.factory(fakeRequire)

	const registrations = []
	const effects = []
	const services = {
		slots: {
			inject: (key, callback) => {
				callback()
			},
			register: (meta, component) => {
				registrations.push({ meta, component })
				return () => {}
			},
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	const ctx = {
		get: (name) => services[name],
		effect: (fn, label) => {
			effects.push({ fn, label })
			const dispose = fn()
			if (typeof dispose === 'function') effects.push({ dispose })
		},
	}

	plugin.apply(ctx)

	assert.equal(registrations.length, 2)
	assert.equal(registrations[0].meta.name, 'conversation.input.overlay')
	assert.equal(registrations[0].meta.id, 'composer-predict-ghost')
	assert.equal(registrations[0].meta.locale, 'composer-predict')
	assert.equal(registrations[1].meta.name, 'settings.section')
	assert.equal(registrations[1].meta.id, 'composer-predict')
	assert.equal(registrations[1].meta.label(), 'Predictions')

	// Keydown capture is installed and is the last effect registered.
	const install = effects.find((entry) => entry.label === 'composer-predict: keydown')
	assert.ok(install !== undefined, 'keydown effect missing')
	assert.ok(listeners.some((entry) => entry.type === 'keydown'), 'keydown listener missing')

	// Devtools escape hatch exists for manual verification.
	assert.equal(typeof window.__composerPredict, 'object')
	assert.equal(typeof window.__composerPredict.state, 'function')
	assert.equal(window.__composerPredict.state().text, '')
})

test('the overlay component renders without throwing for an idle empty composer', () => {
	const { definition } = loadBundle()
	const plugin = definition.factory(fakeRequire)
	let overlay = null
	const services = {
		slots: {
			inject: (key, callback) => callback(),
			register: (meta, component) => {
				if (meta.name === 'conversation.input.overlay') overlay = component
				return () => {}
			},
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })
	assert.ok(overlay !== null)

	const assist = { text: '', sessionId: 's1', turn: 0, fetching: false, error: '' }
	const element = overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		inputActions: { setDraft: () => {} },
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(assist),
		useConfig: (selector) => selector({ enabled: true }),
		t: (key) => key,
		api: { schedule: () => {}, accept: () => false, dismiss: () => false, clear: () => {} },
	})
	assert.ok(element !== null && typeof element === 'object')
	assert.equal(element.props['data-composer-predict'], '')
})

test('a visible suggestion renders ghost text and the hint', () => {
	const { definition } = loadBundle()
	const plugin = definition.factory(fakeRequire)
	let overlay = null
	const services = {
		slots: {
			inject: (key, callback) => callback(),
			register: (meta, component) => {
				if (meta.name === 'conversation.input.overlay') overlay = component
				return () => {}
			},
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })

	const assist = { text: 'Add a regression test for the empty-input case.', sessionId: 's1', turn: 3, fetching: false, error: '' }
	const element = overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(assist),
		useConfig: (selector) => selector({ enabled: true }),
		inputActions: { setDraft: () => {} },
		t: (key) => key,
		api: { schedule: () => {}, accept: () => false, dismiss: () => false, clear: () => {} },
	})
	// Geometry is measured in a layout effect (not run by the fake React), so
	// the first paint is the bare anchor; the store still carries the offer.
	assert.equal(element.props['data-composer-predict'], '')
})

test('an offer survives switching away and back until it is used', () => {
	const { definition, window } = loadBundle()
	const plugin = definition.factory(fakeRequire)
	let overlay = null
	const services = {
		slots: {
			inject: (key, callback) => callback(),
			register: (meta, component) => {
				if (meta.name === 'conversation.input.overlay') overlay = component
				return () => {}
			},
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })
	assert.ok(overlay !== null)
	const api = window.__composerPredict

	// Render once so the component records the current session, then seed an
	// offer through the debug hook (equivalent to a finished prediction).
	overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(api.state()),
		useConfig: (selector) => selector({ enabled: true }),
		inputActions: { setDraft: () => {} },
		t: (key) => key,
		api,
	})
	assert.equal(api.suggest('Run the integration tests.'), true)
	assert.equal(api.state().text, 'Run the integration tests.')

	// Switching away hides it...
	api.showSession('s2')
	assert.equal(api.state().text, '')
	assert.equal(api.state().sessionId, '')

	// ...switching back restores the very same offer, without a new request.
	api.showSession('s1')
	assert.equal(api.state().text, 'Run the integration tests.')
	assert.equal(api.state().sessionId, 's1')

	// Accepting/clearing drops the cache: coming back must not resurrect it.
	api.clear()
	assert.equal(api.state().text, '')
	api.showSession('s1')
	assert.equal(api.state().text, '')

	// Switching the feature off forgets the session outright, so switching it
	// back on can ask again for the same turn.
	assert.equal(api.suggest('Try again.'), true)
	api.forget('s1')
	api.showSession('s1')
	assert.equal(api.state().text, '')
})

test('Tab and Escape belong to the composer while the draft is non-empty', () => {
	const { definition, window, listeners, FakeHTMLElement } = loadBundle()
	const plugin = definition.factory(fakeRequire)
	let overlay = null
	const services = {
		slots: {
			inject: (key, callback) => callback(),
			register: (meta, component) => {
				if (meta.name === 'conversation.input.overlay') overlay = component
				return () => {}
			},
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: (fn) => { fn() } })
	assert.ok(overlay !== null)
	const api = window.__composerPredict
	const keydown = listeners.find((entry) => entry.type === 'keydown')
	assert.ok(keydown !== undefined, 'keydown listener missing')

	const drafts = []
	const render = (draft) => overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(api.state()),
		useConfig: (selector) => selector({ enabled: true }),
		inputActions: { setDraft: (text) => drafts.push(text) },
		t: (key) => key,
		api,
	})

	// An offer exists for the turn and the composer shows the ghost.
	render('')
	assert.equal(api.suggest('Run the integration tests.'), true)

	const target = new FakeHTMLElement()
	target.isContentEditable = true
	target.closest = () => ({})
	const tabEvent = () => ({
		key: 'Tab', keyCode: 9, isComposing: false,
		shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
		target,
		preventDefault() { this.prevented = true },
		stopPropagation() { this.stopped = true },
	})

	// Typing '@' (the file picker) hides the ghost but keeps the offer cached:
	// Tab must reach the composer untouched and must not insert the prediction.
	render('@_c')
	const pickerTab = tabEvent()
	keydown.handler(pickerTab)
	assert.equal(pickerTab.prevented, undefined)
	assert.equal(pickerTab.stopped, undefined)
	assert.deepEqual(drafts, [])
	assert.equal(api.state().text, 'Run the integration tests.')

	// Back on the empty composer the same gesture accepts the offer again.
	render('')
	const acceptTab = tabEvent()
	keydown.handler(acceptTab)
	assert.equal(acceptTab.prevented, true)
	assert.deepEqual(drafts, ['Run the integration tests.'])
	assert.equal(api.state().text, '')
})

test('the nav glyph targets only our own Settings row', () => {
	const rows = [
		{ textContent: 'Account' },
		{ textContent: '  Predictions ' },
		{ textContent: 'Agent presets' },
	]
	const root = { querySelectorAll: () => rows }
	assert.equal(findNavButton(root, 'Predictions'), rows[1])
	assert.equal(findNavButton(root, 'Models'), null)
	assert.equal(findNavButton(null, 'Predictions'), null)
	assert.equal(findNavButton(root, ''), null)
})

test('the nav glyph CSS masks a data-URL icon instead of the shell gear', () => {
	assert.match(NAV_GLYPH_CSS, /data-composer-predict-nav/)
	assert.match(NAV_GLYPH_CSS, /display: none/)
	assert.match(NAV_GLYPH_CSS, /data:image\/svg\+xml/)
	assert.match(NAV_GLYPH_CSS, /mask:/)
})
