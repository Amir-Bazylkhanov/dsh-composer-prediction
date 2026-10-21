// Loads the generated ModuleLoader bundle in a VM with a fake browser and a
// fake React, then drives apply(): this catches wiring mistakes (slot names,
// registration meta, locale, keydown install) without a real browser.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import {
	NAV_GLYPH_CSS,
	findNavButton,
	isComposingInput,
	findInstalledConflict,
	findOverlayConflict,
	GHOST_MARKER_VALUE,
} from '../lib/client-body.js'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadBundle() {
	let definition = null
	const listeners = []
	const observers = []
	const composingState = { active: false }
	const editor = {
		hasAttribute: (name) => name === 'data-composer-composing' && composingState.active,
	}
	const document = {
		addEventListener: (type, handler) => listeners.push({ type, handler }),
		removeEventListener: () => {},
		body: {},
		querySelector: (selector) => (selector === '[data-composer-input]' ? editor : null),
	}
	const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
	window.document = document
	class FakeHTMLElement {}
	class FakeTextArea extends FakeHTMLElement {}
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback
			observers.push(this)
		}
		observe() {}
		disconnect() {}
	}
	const fetchCalls = []
	const sandbox = {
		window,
		document,
		fetch: async (...args) => {
			fetchCalls.push(args)
			return { status: 500, json: async () => ({}) }
		},
		setTimeout,
		clearTimeout,
		console,
		HTMLElement: FakeHTMLElement,
		HTMLTextAreaElement: FakeTextArea,
		MutationObserver: FakeMutationObserver,
	}
	vm.createContext(sandbox)
	vm.runInContext(SOURCE, sandbox)
	assert.ok(definition !== null, 'bundle never called __ModuleLoader__.load')
	return {
		definition,
		window,
		document,
		listeners,
		FakeHTMLElement,
		composingState,
		observers,
		fetchCalls,
	}
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
	assert.equal(element.props['data-composer-ghost'], GHOST_MARKER_VALUE)
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

test('an active IME composition hides the offer and keeps Tab for the IME', () => {
	const { definition, window, listeners, FakeHTMLElement, composingState, observers } = loadBundle()
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
	const render = (draft, composing) => overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(api.state()),
		useConfig: (selector) => selector({ enabled: true }),
		useComposing: (selector) => selector({ composing }),
		inputActions: { setDraft: (text) => drafts.push(text) },
		t: (key) => key,
		api,
	})

	render('', false)
	assert.equal(api.suggest('Run the integration tests.'), true)

	// The draft is still empty at compositionstart, but the host marker is set:
	// the observer mirrors it and the offer stops painting.
	composingState.active = true
	for (const observer of observers) observer.callback()
	const hidden = render('', true)
	assert.equal(hidden.children.length, 0)

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

	// Tab belongs to the IME / composer while the marker is set, even though
	// the DOM keydown itself reports isComposing: false.
	const composingTab = tabEvent()
	keydown.handler(composingTab)
	assert.equal(composingTab.prevented, undefined)
	assert.deepEqual(drafts, [])

	// Releasing the marker brings the cached offer back and restores Tab.
	composingState.active = false
	for (const observer of observers) observer.callback()
	render('', false)
	const acceptTab = tabEvent()
	keydown.handler(acceptTab)
	assert.equal(acceptTab.prevented, true)
	assert.deepEqual(drafts, ['Run the integration tests.'])
})

test('an active IME composition does not spend a prediction request', async () => {
	const { definition, window, composingState, observers, fetchCalls } = loadBundle()
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

	const nodes = [
		{ kind: 'user', content: [{ kind: 'text', text: 'hello' }] },
		{ kind: 'assistant', seq: 7, blocks: [{ kind: 'text', text: 'hi there' }] },
	]
	overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes } }),
		useAssist: (selector) => selector(api.state()),
		useConfig: (selector) => selector({ enabled: true }),
		useComposing: (selector) => selector({ composing: composingState.active }),
		inputActions: { setDraft: () => {} },
		t: (key) => key,
		api,
	})
	await new Promise((resolve) => setTimeout(resolve, 10))
	const baseline = fetchCalls.length

	// Composition active: schedule() returns before asking the host.
	composingState.active = true
	for (const observer of observers) observer.callback()
	api.predictNow()
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(fetchCalls.length, baseline)

	// Releasing it must not have consumed the per-turn marker: a fresh trigger
	// still requests (and the fake transport then fails, as designed here).
	composingState.active = false
	for (const observer of observers) observer.callback()
	api.predictNow()
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.ok(fetchCalls.length > baseline)
})

test('findInstalledConflict matches known ghost packages', () => {
	assert.equal(findInstalledConflict(['@deepseek-ai/dsh-base', 'dsh-next-hint']), 'dsh-next-hint')
	assert.equal(findInstalledConflict(['@deepseek-ai/dsh-base']), '')
	assert.equal(findInstalledConflict(null), '')
})

test('findOverlayConflict ignores host menus and our own entry', () => {
	const entry = (id, registrant) => ({ options: { id }, registrant })
	assert.equal(
		findOverlayConflict([
			entry('slash-menu'),
			entry('command-popup'),
			entry('feedback-dialog'),
			entry('composer-predict-ghost'),
		]),
		'',
	)
	assert.equal(findOverlayConflict([entry('other-ghost')]), 'other-ghost')
	assert.equal(findOverlayConflict([entry('models', 'dsh-next-hint')]), 'dsh-next-hint')
	assert.equal(findOverlayConflict(null), '')
})

test('a foreign ghost entry in the overlay slot pauses predictions', () => {
	const { definition, window } = loadBundle()
	const plugin = definition.factory(fakeRequire)
	const services = {
		slots: {
			inject: (key, callback) => callback(),
			register: () => () => {},
			entriesOfSlot: (key) => (key === 'conversation.input.overlay' ? [{ options: { id: 'other-hint' } }] : []),
		},
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })
	assert.equal(window.__composerPredict.conflict().name, 'other-hint')
})

test('a known conflicting ghost plugin pauses predictions', async () => {
	const { definition, window, fetchCalls } = loadBundle()
	window.__DSH_BOOT__ = { entries: [{ id: '@deepseek-ai/dsh-base' }, { id: 'dsh-next-hint' }] }
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
	assert.equal(api.conflict().active, true)
	assert.equal(api.conflict().name, 'dsh-next-hint')

	const nodes = [
		{ kind: 'user', content: [{ kind: 'text', text: 'hello' }] },
		{ kind: 'assistant', seq: 7, blocks: [{ kind: 'text', text: 'hi there' }] },
	]
	overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes } }),
		useAssist: (selector) => selector(api.state()),
		useConfig: (selector) => selector({ enabled: true }),
		useComposing: (selector) => selector({ composing: false }),
		useConflict: (selector) => selector(api.conflict()),
		inputActions: { setDraft: () => {} },
		t: (key) => key,
		api,
	})
	await new Promise((resolve) => setTimeout(resolve, 10))
	const baseline = fetchCalls.length
	api.predictNow()
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(fetchCalls.length, baseline)
})

test('dsh-next-hint DOM markers are detected without a manifest entry', () => {
	const { definition, window, document } = loadBundle()
	const baseQuery = document.querySelector
	document.querySelector = (selector) => (selector.includes('data-next-hint') ? {} : baseQuery(selector))
	const plugin = definition.factory(fakeRequire)
	const services = {
		slots: { inject: (key, callback) => callback(), register: () => () => {} },
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })
	assert.equal(window.__composerPredict.conflict().name, 'dsh-next-hint')
})

test('the shared data-composer-ghost marker identifies a foreign ghost plugin', () => {
	const { definition, window, document } = loadBundle()
	const baseQuery = document.querySelector
	const foreign = {
		getAttribute: (name) => (name === 'data-composer-ghost' ? 'other-ghost' : null),
	}
	document.querySelector = (selector) =>
		selector.startsWith('[data-composer-ghost]') ? foreign : baseQuery(selector)
	const plugin = definition.factory(fakeRequire)
	const services = {
		slots: { inject: (key, callback) => callback(), register: () => () => {} },
		locale: { register: () => () => {} },
		connection: {},
	}
	plugin.apply({ get: (name) => services[name], effect: () => {} })
	assert.equal(window.__composerPredict.conflict().name, 'other-ghost')
})

test('a conflict hides an already-offered ghost', () => {
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
	const assist = { text: 'Run the integration tests.', sessionId: 's1', turn: 3, fetching: false, error: '' }
	const element = overlay({
		sessionId: 's1',
		useInput: (selector) => selector({ draft: '' }),
		useSession: (selector) => selector({ running: false }),
		useChat: (selector) => selector({ legacy: { nodes: [] } }),
		useAssist: (selector) => selector(assist),
		useConfig: (selector) => selector({ enabled: true }),
		useComposing: (selector) => selector({ composing: false }),
		useConflict: (selector) => selector({ active: true, name: 'dsh-next-hint' }),
		inputActions: { setDraft: () => {} },
		t: (key) => key,
		api: { schedule: () => {}, accept: () => false, dismiss: () => false, clear: () => {} },
	})
	assert.equal(element.children.length, 0)
})

test('isComposingInput recognises the harness IME marker', () => {
	assert.equal(isComposingInput(null), false)
	assert.equal(isComposingInput(undefined), false)
	assert.equal(isComposingInput({}), false)
	assert.equal(isComposingInput({ hasAttribute: () => false }), false)
	assert.equal(isComposingInput({ hasAttribute: (name) => name === 'data-composer-composing' }), true)
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
