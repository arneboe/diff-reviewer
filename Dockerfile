# syntax=docker/dockerfile:1

# Builds the Diff Reviewer VS Code extension and exports the packaged .vsix.
#
# Usage:
#   docker build --output type=local,dest=dist .
#
# The .vsix ends up in ./dist/ on the host.

ARG NODE_VERSION=22
ARG VSCE_VERSION=3

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG VSCE_VERSION

# git is required by the unit tests (gitAdapter / repo discovery)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip the husky "prepare" hook - there is no .git inside the build context
ENV HUSKY=0

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN mkdir -p /artifacts \
    && npm run lint \
    && npm test \
    && npx --yes "@vscode/vsce@${VSCE_VERSION}" package --out /artifacts/

FROM scratch AS export
COPY --from=build /artifacts/ /
