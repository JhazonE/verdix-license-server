FROM node:20-alpine

# provision-cloud shells out to mysqldump/mysql to clone the reference schema.
# Without these the Provision Database step fails at runtime in the container.
RUN apk add --no-cache mariadb-client

WORKDIR /app
COPY package*.json ./
RUN npm install --production=false
COPY . .
EXPOSE 4100
CMD ["npx", "tsx", "src/server.ts"]
