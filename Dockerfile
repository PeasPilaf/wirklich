FROM node:18-alpine AS base
WORKDIR /app
RUN apk add --no-cache \
    udev \
    ttf-freefont \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates
    
COPY package.json ./

RUN npm install --only=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin 

COPY screenshotter.js .
RUN mkdir screenshots && chown node:node screenshots

USER node
ENTRYPOINT ["node", "/app/screenshotter.js"]
CMD ["https://example.com", "--outputDir=/app/screenshots"]