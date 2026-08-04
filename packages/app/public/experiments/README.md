# HaoLab Experiments

This directory contains trusted, self-contained experiment page packages loaded by `/experiment`.

## Add an experiment

1. Create a unique directory such as `stroop/`.
2. Put the complete page package in that directory. The entry point should normally be `index.html`.
3. Use relative URLs for scripts, styles, images, audio, and other assets.
4. Add the package to `manifest.json` and set `active` to the experiment ID that `/experiment` should load.
5. Verify both `/experiments/<directory>/index.html` and `/experiment`.

Example manifest:

```json
{
  "active": "stroop",
  "experiments": [
    {
      "id": "stroop",
      "name": "Stroop Task",
      "entry": "stroop/index.html"
    }
  ]
}
```

## Package contract

- Keep the full experiment flow inside the page package.
- Do not import code from another experiment package.
- Do not access `window.parent`, `window.top`, or HaoLab desktop APIs directly.
- Do not place credentials or participant secrets in the package.
- The entry must be a relative path under this directory. URLs and `..` path segments are rejected.
- The host iframe currently allows scripts, forms, modals, popups, and downloads, but does not grant same-origin access.
- Do not call the OpenCode HTTP API directly. Agent chat must use the host bridge below.

## Agent chat bridge

Send one request at a time from the experiment page:

```js
window.parent.postMessage({
  type: "haolab.agent.send",
  requestId: crypto.randomUUID(),
  text: "Participant message"
}, "*")
```

Listen for `haolab.agent.ready`, `haolab.agent.response`, and `haolab.agent.error` messages. Match responses with the original `requestId`. To start a fresh conversation, send `{ type: "haolab.agent.reset" }` and wait for `haolab.agent.reset.complete`.

The host creates an isolated OpenCode Session, selects an already configured model, and keeps credentials outside the experiment iframe. The optional manifest `agent` field selects an existing OpenCode agent and defaults to `build`.
