# SPIKE (do not merge), #698 decision 5: the probe pod's image. Built and loaded into kind in CI only.
# The build context (run.sh) holds this file, probe.sh, wrap.mjs and srt/: the repo's package.json and
# package-lock.json after `npm ci --omit=dev`, so sandbox-runtime is the lockfile's 0.0.78 with its locked deps.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap=0.8.0-2+deb12u1 socat=1.7.4.4-2 ripgrep=13.0.0-4+b2 \
  && rm -rf /var/lib/apt/lists/*
COPY srt/ /opt/srt/
COPY probe.sh wrap.mjs /opt/probe/
USER 1000:1000
ENTRYPOINT ["bash", "/opt/probe/probe.sh"]
