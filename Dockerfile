FROM node:20-slim
RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .

# 先 build 前端，產生最新的 frontend/dist
WORKDIR /src/frontend
RUN npm install
# 清掉舊的編譯產物與 Vite 快取，避免內容變更但 bundle hash 沒跟著更新
RUN rm -rf dist node_modules/.vite
# date 的輸出每次都不同，保證這一層快取必定失效，不依賴外部傳入 build-arg
RUN date
RUN npm run build

# 回到 server 根目錄，安裝後端依賴並啟動
WORKDIR /src
RUN npm install
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/index.ts"]
