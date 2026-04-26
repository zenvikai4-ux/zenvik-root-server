# Zenvik AI — Root Server

Unified webhook server for all Zenvik AI products.

## What it does
- Receives WhatsApp & Instagram webhooks from Meta
- AI-powered auto-replies via Groq (llama-3.1-8b-instant)
- Routes messages to correct product (Zenvik AI / Gym / School etc.)
- Website chatbot (/chat endpoint)
- Demo form lead capture (/lead endpoint)
- Alerts owner on urgent messages

## Deploy on Railway
1. Connect this GitHub repo to Railway
2. Add environment variables from .env.example
3. Railway auto-deploys on every push to main

## Endpoints
- GET  /          → health check
- GET  /webhook   → Meta webhook verification
- POST /webhook   → incoming WA/Instagram messages
- POST /chat      → website AI chatbot
- POST /lead      → demo form submission
