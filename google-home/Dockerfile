FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json server.js ./
RUN npm ci --omit=dev
ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
