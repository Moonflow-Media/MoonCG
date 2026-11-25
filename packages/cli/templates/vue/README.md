# {{title}}

A MoonCG bundle built with Vite and Vue, created with
`mooncg bundle create {{name}} --template vue`.

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `mooncg.json`             | The manifest: what the bundle provides, and `dev.url` for the dev server |
| `src/dashboard/`          | The panel: `control.html` and the Vue component it mounts                |
| `src/graphics/`           | The graphic, for a browser source in OBS or vMix                         |
| `src/client.js`           | The MoonCG client both pages share                                       |
| `schemas/message.json`    | The JSON Schema every value of the `message` replicant must fit          |
| `vite.config.js`          | Builds `src/` into `dashboard/` and `graphics/`, which MoonCG serves     |
| `local-only.js`           | Keeps the proxy to MoonCG to this machine                                |
| `dashboard/`, `graphics/` | The built pages. Created by `npm run build`                              |

## Setting it up

```sh
npm install
npm run build
```

`@mooncg/sdk` is not on npm: `package.json` names the copy of the MoonCG this bundle was
created with, by its path on this machine. On another machine, change that path to the
`packages/sdk` folder of a MoonCG there.

## Working on it

Start MoonCG in dev mode in the installation folder, and Vite in this folder:

```sh
mooncg dev          # in the installation folder
npm run dev         # here
```

In dev mode MoonCG sends the panel and the graphic to Vite (`dev.url` in `mooncg.json`), so a
saved `.vue` file is applied at once, without a reload. Vite hands `/ws`, `/api`, `/sdk` and
this bundle's routes and assets on to MoonCG (`MOONCG_URL`, default `http://localhost:9090`),
so the pages work unchanged on both servers. Use `localhost` for both, not `127.0.0.1`.

Keep Vite on this machine while `mooncg dev` runs: no `--host`. Dev mode signs in every request
from this machine as the administrator, and Vite's proxy sends on from this machine whatever
reaches it. `local-only.js` makes the proxy answer 403 to every other computer; keep it as the
`bypass` of every proxied path in `vite.config.js`.

Outside dev mode MoonCG serves the built files in `dashboard/` and `graphics/`: run
`npm run build` before you install the bundle elsewhere or start MoonCG with `mooncg start`.
Installing the bundle runs no npm: everything it needs is in the built files.

Dialogs (`mc.dialogs.open`) do not work from a page Vite serves; try them against the built
files.
