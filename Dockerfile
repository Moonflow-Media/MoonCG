FROM node:22-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD true


FROM base AS build

WORKDIR /mooncg

RUN apt-get update && apt-get install -y python3 build-essential
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package.json package-lock.json ./
COPY workspaces workspaces
COPY tsconfig.json tsdown.config.ts ./
COPY scripts scripts

RUN npm ci

RUN npm run build


FROM base AS npm

WORKDIR /mooncg

RUN apt-get update && apt-get install -y python3 build-essential

COPY package.json package-lock.json ./
COPY --from=build /mooncg/workspaces workspaces

RUN npm ci --omit=dev


FROM base AS runtime

RUN apt-get update \
	&& apt-get install -y git \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mooncg

RUN mkdir cfg bundles logs db assets

COPY package.json index.js ./
COPY --from=npm /mooncg/node_modules node_modules
COPY --from=npm /mooncg/workspaces workspaces
COPY --from=build /mooncg/workspaces/mooncg/dist workspaces/mooncg/dist

# Define directories that should be persisted in a volume
VOLUME /opt/mooncg/logs /opt/mooncg/db /opt/mooncg/assets
# Define ports that should be used to communicate
EXPOSE 9090/tcp

# Define command to run MoonCG
# Using `node` directly is slightly faster than using `mooncg start`.
CMD ["node", "/opt/mooncg/index.js"]
