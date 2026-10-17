# dsh-composer-prediction

Codex-style **composer predictions** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

After each assistant turn, the plugin asks a cheap chat model for the message you
are most likely to send next and paints it as **ghost text in the empty
composer**. Press **Tab** to insert it into the draft (nothing is sent), **Esc**
to dismiss it, or just start typing to discard it. Turn the whole thing off in
**Settings → Predictions**, a dedicated Settings section this plugin
contributes (`settings.section`), because the shipped Plugins page is read-only.

## Behaviour

| Event | Result |
|---|---|
| Assistant turn ends (`running: true → false`) | A prediction is requested after the configured delay |
| Composer is not empty, or you are already typing | Nothing is requested or shown |
| **Tab** while a prediction is visible | The whole suggestion is inserted into the draft; nothing is sent |
| **Esc** while a prediction is visible | The offer is withdrawn and not repeated for that turn |
| You open a session that already has an assistant answer | One prediction is made for its latest turn, then deduped per session + turn |
| You switch to another session and back | The cached offer is restored immediately; no new request is made (up to 40 sessions are remembered) |
| A switched-to session needs a new prediction | It waits for the chat store to swap (node list change, 400 ms cap) so the request can never carry the previous session's transcript |
| You type or attach a file | The offer is hidden; clearing the draft brings it back for the same turn |
| You switch the feature off and back on | Forgets the session's offer and "already asked" marker, then predicts again immediately |
| You accept, dismiss, start a new turn, or disable the feature | The offer is discarded and any in-flight request is cancelled |
| A response arrives late or for an older turn | Dropped — it can never replace or resurrect a newer offer |

## Install

From the npm registry (once published):

```sh
dsh plugin --profile <your-profile> add dsh-composer-prediction
```

Or straight from a checkout:

```sh
dsh plugin --profile <your-profile> add ./dsh-composer-prediction --config.auto-install-peers=false
```

`dsh` links the package into the profile and appends the bundle to
`dsh.profile.bundles` because the package declares `dsh.bundle`. Restart the app
afterwards (a page refresh only reloads the browser half).

Verify the layer composed without booting:

```sh
dsh --profile <your-profile> --dump-config
```

You should see a `# == dsh-composer-prediction` layer and a `composer-predict` row.

Remove it with:

```sh
dsh plugin --profile <your-profile> remove dsh-composer-prediction
```

## Configuration

Everything lives in `$DSH_HOME/composer-predict.json` and in the Settings page.
The document is written by the plugin's host half (merge + atomic rename); it is
not a `settings.yaml` namespace because the 0.2.x `ctx.settings` service is a form
layer over loader entries and no longer hands a plugin a live namespace scope.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (also the Settings toggle) |
| `provider` | `""` | Empty = the deployment default route (`ctx.agentDefaultModel`) |
| `model` | `""` | Empty = the deployment default model |
| `maxTokens` | `64` | Output cap for the prediction |
| `temperature` | `0.8` | Sampling temperature (direct-HTTP transport only) |
| `delayMs` | `0` | Quiet period after a turn before predicting |
| `maxSuggestionChars` | `200` | Hard cap on an offered suggestion |
| `contextMessages` | `10` | Trailing messages fed to the predictor |
| `maxContextChars` | `6000` | Transcript character budget |
| `baseUrl` | `https://api.deepseek.com` | Fallback only: used when no harness LLM service is composed |
| `apiKey` | `""` | Fallback only: `DEEPSEEK_API_KEY`, then `$DSH_HOME/.credentials.yaml` |

### Model and reasoning

By default the plugin calls **the harness's own LLM service** (`ctx.llm`), not a
private endpoint. That means:

- it uses the **same provider route and credentials as your sessions** — with a
  subscription route (`deepseek-account`, Kimi, …) you need no API key at all;
- the model is your **deployment default** (`ctx.agentDefaultModel`, e.g.
  `deepseek-flash`) unless you override `provider`/`model` in Settings;
- **reasoning is pinned to the model's cheapest advertised effort**
  (`model.reasoning.efforts[0]`). A next-message guess should not spend a
  thinking budget; if the model advertises no efforts, the provider default is
  left alone. Output is capped at `maxTokens` (64 by default).

The direct OpenAI-compatible HTTP path (`baseUrl` + `apiKey`) exists only for
compositions with no `ctx.llm`; it is not used in a normal DSH install.

If a prediction cannot run, the reason is no longer swallowed: the Settings card
shows it and the browser console logs `[composer-predict] …`.

### Settings page and status

The plugin contributes its own **Settings → Predictions** section
(`settings.section`, the same list slot that hosts "Built-in plugins"), with the
enable switch, provider/model overrides and timing.

There is no placeholder state: the ghost text simply appears when it is ready.
When a prediction comes back empty or fails, the composer shows the reason
instead (`no prediction: no-model-route`, `composer-predict: provider HTTP 401`, …)
and keeps showing it until you type, dismiss it, switch session, or disable the
feature. The console logs `[composer-predict] …` in both cases.

## How it works

```
 host half (lib/index.js, lib/handler.js)
   ├─ config document `composer-predict.json`  → $DSH_HOME
   └─ POST /api/composer-predict/rpc         → config.get / config.set / predict / cancel
                                                └─ chat completion → normalizeSuggestion()

 browser half (lib/client.js)
   ├─ slot conversation.input.overlay  → ghost text over the empty composer
   ├─ slot settings.section            → "Predictions" Settings page
   ├─ useChat(legacy.nodes)            → transcript tail
   ├─ useInput(draft) / useSession(running) → eligibility
   └─ capture keydown                  → Tab accepts, Esc dismisses
```

The overlay measures the real `[data-composer-input]` element and clones its
font metrics, so padding, wrapping and height follow the composer instead of
guessing at CSS. The native placeholder is hidden (and restored) only while the
ghost is visible.

Bundles are built without a toolchain: `scripts/build-client.mjs` concatenates
the shared helpers and the component body into the `window.__ModuleLoader__`
factory the host serves — no bundler, no dependencies, no network.

## Development

```sh
node scripts/build-client.mjs   # regenerate lib/client.js
node scripts/test.mjs           # 32 assertions across shared/host/client
node --check lib/index.js
```

Tests cover suggestion normalization, transcript extraction, prompt building,
config sanitization, every RPC endpoint (with a stubbed provider), cancellation,
and a VM smoke test that loads the generated bundle, runs `apply()` and renders
the overlay.

### Manual verification

The client exposes `window.__composerPredict` so the overlay can be exercised
without waiting for a turn:

```js
__composerPredict.suggest('Add a regression test for the empty-input case.')
__composerPredict.state()
__composerPredict.clear()
__composerPredict.predictNow()   // re-run the real prediction path
```

## Limitations

- The prediction triggers on the idle transition; if you are already typing when
  the turn ends, no offer is made (deliberately: it should never fight the user).
- The ghost is positioned over the first line of an empty composer; a composer
  pre-filled with attachments does not show an offer.
- `predictNow` needs a finished turn to have transcript context.
- Verified against DSH `0.2.1-rc.2`; the client bundle targets the
  `conversation.input.overlay` slot and the `data-composer-input` contenteditable
  introduced in `0.1.5`.

## License

MIT
