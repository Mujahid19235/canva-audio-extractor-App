FROM node:22-slim

WORKDIR /app

# Copy package manifests and install dependencies (skipping strict engine check if needed)
COPY package.json package-lock.json .npmrc ./
COPY scripts/copy_env.ts ./scripts/copy_env.ts
RUN npm ci --omit=dev --engine-strict=false || npm install --omit=dev --engine-strict=false

# Install tsx to run the TypeScript backend directly without extra build artifacts
RUN npm install --no-save --engine-strict=false tsx

COPY backend ./backend
COPY utils/backend ./utils/backend
COPY declarations ./declarations
COPY tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV CANVA_BACKEND_PORT=3001

EXPOSE 3001

CMD ["npx", "tsx", "./backend/server.ts"]
