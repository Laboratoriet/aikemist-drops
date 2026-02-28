FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY index.ts ./

RUN npx tsc

# Remove dev deps after build
RUN npm prune --production

EXPOSE 3002

CMD ["node", "dist/index.js"]
