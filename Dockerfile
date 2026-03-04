FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    ffmpeg \
    streamlink \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p recordings

EXPOSE 3000

CMD ["node", "src/server.js"]

