FROM ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-17-pgvector && \
    rm -rf /var/lib/apt/lists/*
USER 26
