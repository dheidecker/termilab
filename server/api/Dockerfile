FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
EXPOSE 8110
CMD ["node", "src/server.js"]
