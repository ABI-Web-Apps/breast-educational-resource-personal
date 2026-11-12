# Standalone site: build the Vue app, serve it with nginx, proxy /api to the
# FastAPI backend. Used by ../docker-compose.yml; the portal does not use this
# (it builds the UMD bundle with `yarn build:plugin` itself).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM nginx:1.27-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
