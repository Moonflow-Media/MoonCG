# MoonCG

[![MoonCG](https://github.com/Moonflow-Media/MoonCG/blob/da349cc261fb0929c8f41b391dbe29b497c89cd4/media/splash.png)](https://mooncg.dev/)

[![Build Status](https://github.com/Moonflow-Media/MoonCG/workflows/CI/badge.svg)](https://github.com/Moonflow-Media/MoonCG/actions?query=workflow%3ACI)
[![Coverage Status](https://codecov.io/gh/Moonflow-Media/MoonCG/graph/badge.svg?token=8DJ802MHOR)](https://codecov.io/gh/Moonflow-Media/MoonCG)
[![Docker Build Status](https://ghcr-badge.egpl.dev/Moonflow-Media/MoonCG/latest_tag)](https://ghcr.io/Moonflow-Media/MoonCG)

MoonCG is a broadcast graphics framework and application. It enables you to write complex, dynamic broadcast graphics using the web platform. MoonCG has no graphics or drawing primitives of its own. Instead, MoonCG provides a structure for your code and an API to facilitate moving data between the dashboard, the server, and your graphics. It makes few assumptions about how to best code a graphic, and gives you freedom to use whatever libraries, frameworks, tools, and methodologies you want. As such, MoonCG graphics can be rendered in any environment that can render HTML, including:

- [OBS Studio](https://obsproject.com/)
- [vMix](http://www.vmix.com/)
- [XSplit](https://www.xsplit.com/)
- [CasparCG](https://github.com/CasparCG/server/releases) (v2.2.0+)

> Don't see your preferred streaming software on this list? MoonCG graphics require a modern browser engine. If your streaming software's implementation of browser source uses a recent-ish browser engine, chances are that MoonCG graphics will work in it. You can check what version your streaming software uses for its browser sources by opening [whatversion.net/chrome](https://www.whatversion.net/browser/) as a browser source.

## Documentation & API Reference

Full docs and API reference are available at https://mooncg.dev

## Development

To contribute to MoonCG development:

```bash
# Clone the repository
git clone https://github.com/Moonflow-Media/MoonCG.git
cd mooncg

# Install dependencies
npm install

# Run auto-rebuild + type-check on file changes
npm run dev

# Build all workspace packages
npm run build

# Run tests
npx vitest run

# Start MoonCG
npm start
```

For more details on contributing to MoonCG core, see [the contributor guide on the official docs site](https://mooncg.dev/docs/working-on-mooncg-core)

## Goals

The MoonCG project exists to accomplish the following goals:

- Make broadcast graphics (also known as "character generation" or "CG") more accessible.
- Remain as close to the web platform as possible.
- Support broadcasts of any size and ambition.

Let's unpack what these statements mean:

### > Make broadcast graphics (also known as "character generation" or "CG") more accessible

Historically, broadcast graphics have been expensive. They either required expensive hardware, expensive software, or both. MoonCG was originally created to provide real-time broadcast graphics for Tip of the Hats, which is an all-volunteer charity fundraiser that had a budget of \$0 for its first several years.

Now, it is possible to create an ambitious broadcast using entirely free software and consumer hardware. The MoonCG project embraces this democratization of broadcast technology.

### > Remain as close to the web platform as possible

MoonCG graphics are just webpages. There is absolutely nothing special or unique about them. This is their greatest strength.

By building on the web platform, and not building too many abstractions on top of it, people developing broadcast graphics with MoonCG have access to the raw potential of the web. New APIs and capabilities are continually being added to the web platform, and MoonCG developers should have access to the entirety of what the web can offer.

### > Support broadcasts of any size and ambition

MoonCG's roots are in small broadcasts with no budget. More recently, MoonCG has begun seeing use in increasingly elaborate productions. We believe that one set of tools can and should be able to scale up from the smallest show all the way to the biggest fathomable show. Whether you're using OBS for everything, or a hardware switcher with a traditional key/fill workflow, MoonCG can be a part of any broadcast graphics system.

## Maintainers

- [Dominik "ElyFura" Seng](https://github.com/ElyFura)

## Original Maintainers

- [Matt "Bluee" McNamara](https://mattmcn.com/)
- [Keiichiro "Hoishin" Amemiya](https://twitter.com/hoishinxii)

## Designers

- [Chris Hanel](http://www.chrishanel.com)

## Acknowledgements

- [Atmo](https://github.com/atmosfar), original dashboard concept and code, the inspiration for toth-overlay
- [Alex "Lange" Van Camp](https://github.com/alvancamp), designer & developer of [toth-overlay](https://github.com/TipoftheHats/toth-overlay), the base on which MoonCG was built
