# Student API keys for the personal agent

Students bring their own free key. EPSynapse forwards each chat turn and does not store the key. It lives in `localStorage` on that browser.

Live page: https://epsynapse.com (chat pill on the dashboard). `/agent.html` redirects there.

## What to tell a student

1. Open Groq. Sign in with Google. No credit card.
2. Create a key at [console.groq.com/keys](https://console.groq.com/keys).
3. Paste it on the agent page. Ask something.

That key runs `openai/gpt-oss-120b`, a reasoning model, at Groq speed. Free tier is about 30 requests a minute and 1000 a day. Enough for one student talking through a school day.

## The other two options

**Gemini.** [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Same Google account they already have. Stronger thinking. Google may use free-tier prompts to improve the product, which matters if we ever put this in front of a school lawyer.

**OpenRouter.** [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). One key, many `:free` models, including `openrouter/free`. Caps are tighter, about 50 chats a day unless they add $10.

Do not send students to OpenAI or Anthropic for this. Those keys are paid.

## Table demo

If `DEMO_GROQ_KEY` is set in `server/.env`, a visitor with no pasted key can still talk through Groq. That is for the hackathon table. Students should still paste their own key so they are not sharing one quota.

Never commit the demo key.

## What we do not do

- We do not host an LLM on this Mac.
- We do not put LM Studio on the Cloudflare Tunnel.
- We do not keep student keys on disk or in the database. There is no database.
