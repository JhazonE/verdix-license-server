FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production=false
COPY . .
EXPOSE 4100
CMD ["npx", "tsx", "src/server.ts"]
