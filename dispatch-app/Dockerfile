FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 4173
ENV PORT=4173
CMD ["node", "server.js"]
