FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl

COPY services/orders-service/package.json ./package.json
RUN npm install --only=production

COPY services/orders-service/prisma ./prisma
RUN npx prisma generate

COPY services/orders-service/src ./src
COPY common ./common

ENV PORT=3002
EXPOSE 3002
CMD ["npm","start"]