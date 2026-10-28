FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production=false
COPY . .
EXPOSE 4100
CMD ["npx", "tsx", "src/server.ts"]
