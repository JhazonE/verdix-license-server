# Debian (not Alpine) because provision-cloud shells out to mysqldump/mysql and
# those must be ORACLE MySQL clients, not MariaDB's.
#
# Alpine only ships MariaDB's client (both `mariadb-client` and `mysql-client`
# are the same MariaDB binaries), and MariaDB's client cannot authenticate
# against MySQL 8 at all:
#
#   ERROR 1045: Plugin caching_sha2_password could not be loaded:
#   /usr/lib/mariadb/plugin/caching_sha2_password.so: No such file or directory
#
# Railway's MySQL uses caching_sha2_password, so every provisioning run failed
# with that error. Debian's `default-mysql-client` is MariaDB too, so the real
# Oracle binaries are copied from the official mysql:8 image instead; they need
# libssl3 (mysqldump) and libncurses6 (mysql) from the base.
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 libncurses6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=mysql:8 /usr/bin/mysqldump /usr/bin/mysqldump
COPY --from=mysql:8 /usr/bin/mysql /usr/bin/mysql

WORKDIR /app
COPY package*.json ./
RUN npm install --production=false
COPY . .
EXPOSE 4100
CMD ["npx", "tsx", "src/server.ts"]
