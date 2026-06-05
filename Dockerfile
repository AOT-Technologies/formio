# Used by docker-compose.yml to deploy the formio application
# (When modified, you must include `--build` )
# -----------------------------------------------------------

# Use Node image, maintained by Docker:
# hub.docker.com/r/_/node/
FROM node:24-alpine

# set label for image
LABEL Name="formsflow"

# set working directory
WORKDIR /app

RUN set -x \
	&& chmod -R 777 /app/

# "bcrypt" requires python/make/g++, all must be installed in alpine
# (note: using pinned versions to ensure immutable build environment)
RUN apk update && \
    apk upgrade && \
    apk add make && \
    apk add python3 && \
    apk add g++ && \
    apk add git

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
## Using an alternative package install location
## to allow overwriting the /app folder at runtime
## stackoverflow.com/a/13021677
#ENV NPM_PACKAGES=/.npm-packages \
#    PATH=$NPM_PACKAGES/bin:$PATH \
#    NODE_PATH=$NPM_PACKAGES/lib/node_modules:$NODE_PATH
#RUN echo "prefix = $NPM_PACKAGES" >> ~/.npmrc

# add `/app/node_modules/.bin` to $PATH
ENV PATH /app/node_modules/.bin:$PATH

# Copy full source first (webpack needs src/vm/entries + config at build time)
COPY . /app/

# Install all deps (devDeps needed for webpack/build:vm), build VM bundle, then prune devDeps
RUN npm ci --ignore-scripts && \
    npm run build:vm && \
    npm prune --omit=dev

RUN apk del git

# Set this to inspect more from the application. Examples:
#   DEBUG=formio:db (see index.js for more)
#   DEBUG=formio:*
ENV DEBUG=""


# This will initialize the application based on
# some questions to the user (login email, password, etc.)
ENTRYPOINT [ "node", "--no-node-snapshot", "main" ]
