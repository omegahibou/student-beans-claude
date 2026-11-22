FROM mcr.microsoft.com/playwright:v1.65.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

CMD ["node", "src/index.js"]
