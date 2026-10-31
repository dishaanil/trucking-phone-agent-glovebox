#!/bin/sh
# Regenerate glovebox_agent/api_models.py from the API's exported JSON Schema.
# Run `pnpm schemas:export` in /api first if the API's zod schemas changed.
# Usage: scripts/generate_models.sh [output]   (default: glovebox_agent/api_models.py)
set -eu
cd "$(dirname "$0")/.."
out="${1:-glovebox_agent/api_models.py}"
uv run datamodel-codegen \
  --input ../api/schemas/api.schema.json \
  --input-file-type jsonschema \
  --output "$out" \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.11 \
  --use-standard-collections \
  --use-union-operator \
  --use-title-as-name \
  --field-constraints \
  --collapse-root-models \
  --extra-fields ignore \
  --formatters ruff-format \
  --disable-timestamp \
  --custom-file-header "# Generated from api/schemas/api.schema.json by agent/scripts/generate_models.sh. Do not edit."
