#!/usr/bin/env bash
set -euo pipefail

SERVICE="${SERVICE:-talk2me-relay}"
REGION="${REGION:-us-central1}"
SECRET_NAME="${SECRET_NAME:-gemini-api-key}"
PROJECT_ID="${FIREBASE_PROJECT_ID:-talk2me-e90b1}"
# Who can load the /admin dashboard (comma-separated emails).
ADMIN_EMAILS="${ADMIN_EMAILS:-dalrae.jin.work@gmail.com}"

# Phase 1: the relay requires a verified Firebase ID token. Set this explicitly
# so a --source redeploy can never silently drop back to anonymous access.
# --timeout=1200: max duration of one WebSocket connection (per simulation), not
# login session length. Daily usage is capped separately via LbD credits in Firestore.
# 20 minutes is a Gemini cost safety net; the client no longer auto-ends on a timer.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --timeout=1200 \
  --set-secrets "GEMINI_API_KEY=${SECRET_NAME}:latest" \
  --set-env-vars "REQUIRE_FIREBASE_AUTH=1,FIREBASE_PROJECT_ID=${PROJECT_ID},ADMIN_EMAILS=${ADMIN_EMAILS}" \
  "$@"
