FROM node:18-slim

WORKDIR /app

# Install dependencies for wrtc
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN npm install

COPY server.js .
COPY .env* ./

EXPOSE 3000

CMD ["node", "server.js"]
