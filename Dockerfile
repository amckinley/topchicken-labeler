# Top Chicken labeller — single-stage build, runs the LabelerServer + poller.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. @libsql/client ships prebuilt binaries,
# so no native toolchain is needed.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The label DB + state file live on a mounted volume (see railway.json / docs).
# RAILWAY_VOLUME_MOUNT_PATH is provided by Railway at runtime.
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
