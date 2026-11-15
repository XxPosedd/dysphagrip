FROM node:22-alpine AS build
WORKDIR /app
COPY apps/web/package*.json ./apps/web/
COPY server/package*.json ./server/
RUN npm ci --prefix apps/web && npm ci --prefix server
COPY apps/web ./apps/web
COPY server ./server
ARG VITE_DYSPHAGRIP_PUBLIC=0
ARG VITE_DYSPHAGRIP_BASE=/
ARG VITE_DYSPHAGRIP_SHARED_HOST=0
RUN npm run build --prefix apps/web && npm run build --prefix server && npm prune --omit=dev --prefix server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/assets ./server/assets
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
