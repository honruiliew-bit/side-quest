# Sidequest: Devpost write-up

## Tagline

Group adventures that only run if enough people commit. Hold your spot with PayPal, pay only if it happens.

## Inspiration

Group plans fall apart over commitment and money. Someone suggests a day trip, four people say maybe, and whoever books the van ends up fronting the cost and chasing payments. Rising costs make cheap local adventures more valuable than ever, but nobody wants to be the one left holding the bill.

PayPal already has the right primitive for this: authorize now, capture later. We built a product around it.

## What it does

- **Hold, don't pay.** Joining a quest places a PayPal authorization at the max price, which is the share if only the minimum group shows up.
- **It tips.** When the minimum commits, the quest is on. More people can join, and the share keeps dropping.
- **Final split only.** At the deadline every hold is captured at the real split. Nobody pays more than they approved, and most pay less.
- **Nothing runs, nothing charged.** If the minimum isn't reached, every hold is voided.
- **An agent runs the group.** Claude drafts a full quest from one sentence, answers questions in the group chat, and handles dropouts, standby swaps and cost overruns. It can only propose money moves. The host sees the exact PayPal operations and approves them.
- **After the trip.** Refunds if costs come in under, PayPal invoices through the Agent Toolkit if they come in over, and a PayPal Payout to the host.
- **Agentic commerce.** Sidequest is an MCP server. Claude, ChatGPT or any MCP client can find a quest and start a hold for you. You still approve it on PayPal.

## Business model

Sidequest adds a small fee to each share, collected only when a quest runs (`PLATFORM_FEE_PCT`). Hosts pay nothing to post, and if a quest doesn't run nobody pays anything, including the fee. Hosts are paid through PayPal Payouts after the trip.

## How we built it

- **Backend:** FastAPI, SQLAlchemy and Postgres on Supabase. A single quest engine owns every money move and enforces the rules the agent can't bend: captures never exceed the authorization, refunds never exceed the capture.
- **PayPal:** Orders v2 with `intent: AUTHORIZE`, authorization capture (partial, `final_capture`), void, reauthorize after the honor period, capture refunds, Payouts v1, webhooks with signature verification, and JS SDK Smart Buttons with PayPal, Venmo and cards.
- **PayPal Agent Toolkit:** It ships adapters for OpenAI Agents, LangChain and CrewAI. We wrote a Claude adapter over its shared layer, so the agent uses the toolkit's own tool definitions, parameter models and handlers for orders and invoicing.
- **AI:** Claude with a forced tool call for quest drafts, and a tool-use loop with guarded tools for the quest agent.
- **MCP:** Streamable HTTP server mounted on the API, with `list_quests`, `get_quest`, `hold_spot` and `check_my_spot`.
- **Frontend:** Next.js and Tailwind. The design is a rail platform: a ticket for every quest, a split-flap departure board, a seat map, and a "money route" that shows each PayPal step as a station. Blue is used only for money, so you can always see what is held, charged or refunded.

## Challenges

- **The split has to be safe.** The hold is placed before anyone knows the group size. Holding at the minimum-group price and capturing at the final split means the capture is always at or below the authorization.
- **Dropouts after charging.** After lock, a refund alone would raise everyone else's share. Standby members keep their holds after lock, so a swap is a capture plus a refund and nobody else's price changes.
- **Agents and money.** We wanted the agent to be useful without being trusted with money. Every money move it suggests becomes a proposal that is re-validated against the live state at approval time.

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

1. Open the hosted demo and click **Take the 2-minute tour**.
2. In step 1, approve the hold in PayPal's sandbox popup with the buyer login shown in the panel. Pay with the card or balance, not Pay in 4.
3. Follow the checklist. Each step switches to the right person and runs the next PayPal action.
4. Scroll to **Money log** to see every PayPal call with its ID.
5. On **For AI agents**, click **Call list_quests**, then **Call hold_spot**, to see the agentic commerce flow without installing anything.

## Built with

PayPal Orders v2, PayPal Payments v2, PayPal Payouts, PayPal Invoicing, PayPal Agent Toolkit, PayPal JS SDK, PayPal Webhooks, Claude, Model Context Protocol, FastAPI, SQLAlchemy, Supabase, Next.js, Tailwind CSS, Render.
