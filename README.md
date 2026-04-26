# Gig-Buddy

Personal Instacart shopper analytics tool. Tracks offered batches (accepted and declined), surfaces real $/hr and $/mile by store, type, and time block.

## Structure

- `frontend/` — React PWA (Vite). Mobile-first, add to iPhone home screen.
- `backend/` — Express service deployed on Railway. Accepts Instacart screenshots, extracts structured data via Anthropic API.

## Setup

See `backend/README.md` for Railway deployment instructions.

## Context

See `CLAUDE.md` for full project context, decisions, and next steps.
