FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install

RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    curl \
    procps \
    net-tools \
    iproute2 \
 && rm -rf /var/lib/apt/lists/*

RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]