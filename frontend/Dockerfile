FROM node:22-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend .
COPY docs/img/logo.png /app/docs/img/logo.png
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

FROM nginx:1.28-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
