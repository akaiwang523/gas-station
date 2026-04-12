FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install
RUN npx prisma generate

COPY . .

EXPOSE 8080

CMD ["npm", "start"]CMD ["npm", "start"]
CMD ["npm", "start"]
CMD ["npm", "start"]
