FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install && npm run install:all
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
CMD ["npm","start"]
