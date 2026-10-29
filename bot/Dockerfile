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
    imagemagick \
    tini \
 && rm -rf /var/lib/apt/lists/*

RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

# tini as PID 1 reaps orphaned Chrome processes (node does not)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]