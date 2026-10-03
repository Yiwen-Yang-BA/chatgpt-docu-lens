FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=3103
USER node
EXPOSE 3103
CMD ["node", "--env-file-if-exists=.env", "server.mjs"]
