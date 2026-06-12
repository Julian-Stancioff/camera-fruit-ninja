# --- build the Vite client ---
FROM node:22-alpine AS build
WORKDIR /app
COPY client/package*.json ./
RUN npm ci --ignore-scripts
COPY client/ .
# fetch-assets downloads the MediaPipe model + copies the tasks-vision wasm into
# public/ (kept out of git to keep the repo lean), then Vite bundles everything.
RUN node scripts/fetch-assets.mjs && npm run build

# --- serve the static build ---
FROM nginx:alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
