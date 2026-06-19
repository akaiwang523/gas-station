FROM node:20-slim
RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .

# 先 build 前端，產生最新的 frontend/dist
WORKDIR /src/frontend
RUN npm install
RUN npm run build

# 回到 server 根目錄，安裝後端依賴並啟動
WORKDIR /src
RUN npm install
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/index.ts"]
