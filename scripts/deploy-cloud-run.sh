#!/usr/bin/env bash
set -euo pipefail

SERVICE="${SERVICE:-talk2me-relay}"
REGION="${REGION:-us-central1}"
SECRET_NAME="${SECRET_NAME:-gemini-api-key}"
PROJECT_ID="${FIREBASE_PROJECT_ID:-talk2me-e90b1}"

# Phase 1: the relay requires a verified Firebase ID token. Set this explicitly
# so a --source redeploy can never silently drop back to anonymous access.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets "GEMINI_API_KEY=${SECRET_NAME}:latest" \
  --set-env-vars "REQUIRE_FIREBASE_AUTH=1,FIREBASE_PROJECT_ID=${PROJECT_ID}" \
  "$@"
