# 1. 強制使用 Debian 系統的 Node.js 22 (完美避開 Alpine/musl 的所有衝突)
FROM node:22-slim

# 2. 使用 Debian 的套件管理員安裝 OpenSSL
RUN apt-get update -y && apt-get install -y openssl

# 3. 設定容器內的工作目錄
WORKDIR /app

# 4. 複製 package.json 並安裝所有依賴套件
COPY package*.json ./
RUN npm install

# 5. 複製所有專案原始碼 (包含 prisma 資料夾與 src)
COPY . .

# 6. 在擁有標準 OpenSSL 的環境下產生 Prisma Client
RUN npx prisma generate

# 7. 啟動你的伺服器
CMD ["npm", "run", "start"]