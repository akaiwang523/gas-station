FROM node:20-alpine

RUN apk add --no-cache openssl1.1-compat

WORKDIR /src

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install
RUN npx prisma generate

COPY . .

EXPOSE 8080

CMD ["npm", "start"]