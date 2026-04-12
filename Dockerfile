FROM node:20-slim

RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY . .

RUN npm install

EXPOSE 8080

CMD ["npm", "start"]