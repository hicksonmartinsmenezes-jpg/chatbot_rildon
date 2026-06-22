FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY frontend ./frontend
COPY .env.example ./env.example

EXPOSE 3000
CMD ["node", "src/server.js"]
