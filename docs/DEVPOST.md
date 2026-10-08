# Sidequest: Devpost write-up

## Tagline

Nobody pays unless the quest runs. Hold your spot with PayPal, pay the real split only if it happens.

## Inspiration

Group plans die in the group chat. Someone suggests a day trip, four people say maybe, and whoever books the van ends up fronting the cost and chasing payments.
[Add your pilot number here, e.g. "In our test, 12 friends held spots for a Saturday trip and 9 went."]

PayPal already has the right building block: authorize now, capture later. Sidequest is built around it.

## What it does

1. **Hold, don't pay.** Joining places a PayPal hold for the most you could pay. Nothing is charged.
2. **It runs or it doesn't.** When enough people commit, the host locks and everyone pays the real split, which drops with every extra person. If not enough people commit, every hold is released.
3. **Claude does the admin, the host approves the money.** Claude plans the quest from one sentence, runs the group chat, swaps dropouts with people on standby, and reads receipts to settle up with refunds or PayPal invoices. It can only propose money moves. The host sees the exact PayPal operations and approves them.

Around that core:
- **Escrowed payout.** The host is paid through PayPal Payouts 24 hours after the trip, unless a member reports a problem.
- **Host desk.** An AG Studio dashboard of every payment and who still owes, with nudges sent through PayPal's invoice reminders and Claude to build any view.
- **Agentic commerce.** Sidequest is an MCP server. Claude, ChatGPT or any MCP client can find a quest and start a hold. You still approve it on PayPal. Scout, a small assistant in the corner of every page, uses the same four tools, so judges can try it without installing anything.

## Business model

Sidequest adds a small fee to each share, collected only when a quest runs (`PLATFORM_FEE_PCT`). Hosts pay nothing to post, and if a quest doesn't run nobody pays anything, including the fee. Hosts are paid through PayPal Payouts after the trip.

## How we built it

- **Backend:** FastAPI, SQLAlchemy and Render Postgres. A single quest engine owns every money move and enforces the rules the agent can't bend: captures never exceed the authorization, refunds never exceed the capture.
- **PayPal:** Orders v2 with `intent: AUTHORIZE`, authorization capture (partial, `final_capture`), void, reauthorize after the honor period, capture refunds, Payouts v1, webhooks with signature verification, and JS SDK Smart Buttons with PayPal, Venmo and cards.
- **PayPal Agent Toolkit:** It ships adapters for OpenAI Agents, LangChain and CrewAI. We wrote a Claude adapter over its shared layer, so the agent uses the toolkit's own tool definitions, parameter models and handlers for orders and invoicing.
- **AI:** Claude with a forced tool call for quest drafts, and a tool-use loop with guarded tools for the quest agent.
- **MCP:** Streamable HTTP server mounted on the API, with `list_quests`, `get_quest`, `hold_spot` and `check_my_spot`.
- **Render:** One Blueprint deploys the API, the web app, Postgres, a Cron Job and a Workflow. The Cron Job is the money clock: it starts or cancels quests at their deadline, locks fares and releases escrowed payouts even when nobody has the site open. The Workflow runs settle up: one `send_invoice` task per person, each on its own instance with retries, and deterministic PayPal invoice numbers so a retry can never bill anyone twice.
- **AG Studio + AG Grid:** The host desk is an AG Studio dashboard over three related tables (quests, PayPal events, invoices). A custom widget, Who still owes, ranks open PayPal invoices with a Nudge button. AG Studio's Agent Framework runs all five built-in agents on Claude through our own endpoint, plus one tool we added, `draft_payment_reminder`: Claude writes the nudge, the host sends it through PayPal's Invoicing reminder API. Quest pages keep an AG Grid money log with CSV export.
- **Frontend:** Next.js and Tailwind. The design is a rail platform: a ticket for every quest, a split-flap departure board, a seat map, and a "money route" that shows each PayPal step as a station. Blue is used only for money, so you can always see what is held, charged or refunded.

## Challenges

- **The split has to be safe.** The hold is placed before anyone knows the group size. Holding at the minimum-group price and capturing at the final split means the capture is always at or below the authorization.
- **Dropouts after charging.** After lock, a refund alone would raise everyone else's share. Standby members keep their holds after lock, so a swap is a capture plus a refund and nobody else's price changes.
- **Agents and money.** We wanted the agent to be useful without being trusted with money. Every money move it suggests becomes a proposal that is re-validated against the live state at approval time.
- **Trust in both directions.** Holds protect members from paying for a trip that never happens. A payout window and receipt checks protect them from a host who overcharges or doesn't show.

## Accomplishments

- The full PayPal lifecycle in one product: authorize, capture, void, reauthorize, refund, invoice, payout and webhooks.
- A Claude adapter for the PayPal Agent Toolkit.
- An MCP server that lets any AI assistant commit you to a plan without ever spending on its own.
- A mock mode and demo personas, so judges can play every side of a quest alone in two minutes.

## What we learned

Authorization holds are an underused tool for coordination. A hold is a commitment you can see, and that changes how people answer "are you in?"

## What's next

- Recurring quests with PayPal subscriptions for clubs.
- Host verification and ratings.
- Location-based discovery of nearby quests this weekend.
- PayPal Multiparty, so hosts are paid directly at capture.

## Testing instructions for judges

1. Open https://sidequest-web-q5pq.onrender.com and click **Take the 2-minute tour**. The first load can take up to a minute if the server was asleep.
2. In step 1, approve the hold in PayPal's sandbox popup with the buyer login shown in the bar. Pay with the card or balance, not Pay in 4.
3. Follow the five steps in the bar. Each one switches to the right person and runs the next PayPal action.
4. Scroll to **Money log** to see every PayPal call with its ID.
5. Open **My money** as Hon for the host desk. Press **Nudge** on Leo, then **Edit with Claude** and try **Nudge the oldest invoice**.
6. **For AI agents** (footer): ask the assistant to find a quest and hold a spot. It uses the same MCP tools any AI assistant would, and you approve the hold on PayPal.

## Built with

PayPal Orders v2, PayPal Payments v2, PayPal Payouts, PayPal Invoicing, PayPal Agent Toolkit, PayPal JS SDK, PayPal Webhooks, Claude, Model Context Protocol, Render (web services, Postgres, Cron Jobs, Workflows), AG Studio, AG Grid, FastAPI, SQLAlchemy, Next.js, Tailwind CSS.

## Built during the submission period

All code was written from scratch after the submission period opened on October 1, 2026. Side Quest started as a concept in a university venture course. There was no prior code.
