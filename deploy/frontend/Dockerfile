# syntax=docker/dockerfile:1

# SSphere Sentinel console: the React build served by nginx, which also passes
# the APIs, the Django admin and the health checks on to the web service.
# Build context: ./frontend; the nginx configuration comes as the additional
# context "nginx" (compose.yml, service proxy).

# --- Build the console (the Node line CI checks it with) --------------------
FROM node:24-trixie-slim AS build

WORKDIR /src
# The locked dependencies only; .npmrc keeps their install scripts from running.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# VITE_SENTINEL_API stays unset: a production build always uses the console API.
RUN npm run build

# --- Serve -------------------------------------------------------------------
# nginx without root (uid 101, port 8080); the stable line.
FROM nginxinc/nginx-unprivileged:1.30-alpine

COPY --from=nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html

EXPOSE 8080
