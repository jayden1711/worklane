# A minimal image for the single-user path: a cloud VM or a container trial. The same bootstrap as on a
# machine (scripts/bootstrap.sh): Node.js, gitleaks and the engine, pinned and checksum-checked, for a non-root
# user. Your repo is mounted at /repo; see docs/quickstart.md.
#   docker build -t worklane .
#   docker run --rm -it -v "$PWD:/repo" worklane worklane install --root /repo
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash user
USER user
WORKDIR /home/user
ENV PATH=/home/user/.local/bin:$PATH

# The script, and package.json beside it: it names the repo the engine's release comes from.
COPY --chown=user:user scripts/bootstrap.sh package.json /home/user/
# The engine to install: the pinned release by default, or another npm spec (docker build --build-arg ENGINE=...).
ARG ENGINE=
RUN bash /home/user/bootstrap.sh --no-repo ${ENGINE:+--engine "$ENGINE"} && rm /home/user/bootstrap.sh /home/user/package.json

WORKDIR /repo
CMD ["worklane", "--help"]
