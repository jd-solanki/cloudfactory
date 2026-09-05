# The image line must match the @cloudflare/sandbox package line.
FROM docker.io/cloudflare/sandbox:next

# Only the reviewing agent is installed. A read-only review never runs the
# repository's build, tests, or scripts, so no language toolchain is added.
RUN npm install -g @openai/codex@0.153.2 \
    && npm cache clean --force
