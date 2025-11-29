# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy app files
COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["npm", "start"]

#docker build --platform=linux/amd64 -t registry.k8s.energyhack.cz/team-repo/galactic-energy-exchange:latest .
#docker push registry.k8s.energyhack.cz/team-repo/galactic-energy-exchange:latest