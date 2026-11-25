# {{title}}

A MoonCG bundle, created with `mooncg bundle create {{name}}`.

| Path                     | What it is                                                                  |
| ------------------------ | --------------------------------------------------------------------------- |
| `mooncg.json`            | The manifest: what the bundle provides and which permission each part takes |
| `dashboard/control.html` | The panel in the dashboard                                                  |
| `graphics/overlay.html`  | The graphic, for a browser source in OBS or vMix                            |
| `extension/index.js`     | The code that runs on the server                                            |
| `schemas/message.json`   | The JSON Schema every value of the `message` replicant must fit             |

## Working on it

Start the server in dev mode from the installation folder:

```sh
mooncg dev
```

Dev mode watches this folder. Saving a file applies it: a change in `dashboard/` or
`graphics/` reloads the open pages, one in `extension/` restarts the extension, and one to
`mooncg.json` or a schema reloads the bundle. An invalid manifest is not applied: the bundle
keeps running as it was, and the Bundles page says what is wrong.

Run `mooncg types` in this folder to generate `mooncg-env.d.ts`, which gives
`mc.replicant('message')` its type in an editor.
