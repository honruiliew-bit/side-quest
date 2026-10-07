# Sidequest

Group adventures that only run if enough people commit.

Everyone who joins places a PayPal **authorization hold** at the max price. Nobody is charged unless the quest reaches its minimum. When it locks, each hold is **captured at the final split**, which drops with every extra person. After the trip, the host is paid through **PayPal Payouts**. A Claude agent plans quests, runs the group chat, and handles dropouts, swaps and cost changes. It can only *propose* money moves, and the host approves each one.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com).

![Quest page](docs/screens/quest.png)

## Why it's different

Most group payments collect money first and sort out refunds later. Sidequest uses the authorize-then-capture model PayPal already has, so the group's commitment is real but nobody's money moves until the plan does.

| PayPal capability | Where Sidequest uses it |
|---|---|
| Orders v2, `intent: AUTHORIZE` | Holding a spot. The hold is the price for the minimum group, the most anyone can pay. |
| Capture authorization (partial, `final_capture`) | Locking a quest. Each hold is captured at the real split, always at or below the hold. |
| Void authorization | Leaving before lock, quests that never tip, and standby holds after the trip. |
| Reauthorize | Holds older than the 3 day honor period are reauthorized before capture. |
| Refund capture (partial) | Dropout swaps after lock, and refunds when costs come in under. |
| Payouts v1 | Paying the host after the trip. |
| Invoicing, through the **PayPal Agent Toolkit** | Billing each person when costs come in over. |
| PayPal Agent Toolkit, adapted for Claude | The quest agent can call `get_order_details` and `get_invoice`. |
| Webhooks with signature verification | `CHECKOUT.ORDER.APPROVED` places holds for link-based approvals. Capture, void, refund and payout events confirm the money log. |
| JS SDK Smart Buttons | PayPal, Venmo and Pay Later, with `intent=authorize`. |

And for agentic commerce: **Sidequest is an MCP server.** Claude, ChatGPT or any MCP client can find quests and start a hold. The person approves the hold on PayPal's own page, so an agent can commit you to a plan but can never spend without you.

## How it works

```mermaid
sequenceDiagram
  participant M as Member
  participant S as Sidequest API
  participant P as PayPal
  participant H as Host
  M->>S: Hold my spot
  S->>P: Create order (AUTHORIZE, max price)
  M->>P: Approve
  S->>P: Authorize order
  Note over S: Minimum reached, quest is on
  H->>S: Lock (or deadline passes)
  S->>P: Capture each authorization at the final split
  Note over S: Dropout after lock
  S-->>H: Agent proposes a swap
  H->>S: Approve
  S->>P: Capture standby hold, refund the dropout
  H->>S: Trip done
  S->>P: Payout to host
```

### The agent's guardrails

The agent never moves money on its own. It has five tools of its own plus two read-only PayPal Agent Toolkit tools:

- `get_quest_state` and `price_for` read the quest.
- `leave_quest` acts only for the person speaking. Before lock it voids their own hold. After lock it becomes a proposal.
- `propose_money_actions` creates a proposal (void, promote, refund or invoice) that only the host can approve.
- `add_stop_note` saves answers to the plan.

Every proposal is re-validated by the engine at approval time. A capture can never exceed the authorization, and a refund can never exceed what was captured. Member messages are treated as data, so one person can't talk the agent into moving someone else's money.

## Run it locally (no keys needed)

Requires Python 3.11+ and Node 18+.

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install --no-deps paypal-agent-toolkit==1.11.0
cp .env.example .env
uvicorn main:app --reload

# Frontend, in a second terminal
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000. Without keys, PayPal runs in mock mode and the agent runs offline, so everything works end to end. Five demo quests are seeded, each at a different stage.

## Turn on the PayPal sandbox

1. At [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials**, choose **Sandbox**, and create an app. Copy the client ID and secret into `backend/.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. Under **Sandbox accounts**, make sure you have a business account (it receives holds and sends payouts) and one or more personal accounts (to approve holds).
3. Run the check script. It walks through authorize, partial capture, refund, void, payout and an Agent Toolkit invoice against the real sandbox:
   ```bash
   cd backend && python scripts/check_sandbox.py
   ```
4. Restart the backend. The header badge now says **PayPal sandbox**, and the hold button is PayPal's own Smart Button.
5. Optional: give the demo crowd real sandbox holds. Generate a test card under **Testing tools > Card generator** and set `DEMO_CARD_NUMBER`. Without it, demo crowd joins are simulated and labeled as simulated in the money log.

### Webhooks

Add a webhook in your sandbox app pointing to `https://<your-api>/webhooks/paypal` with these events:

`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`

Set the webhook's ID as `PAYPAL_WEBHOOK_ID`. Each event is verified with PayPal's `verify-webhook-signature` endpoint and stored once.

## Turn on Claude

Set `ANTHROPIC_API_KEY` in `backend/.env`. The quest builder then uses a forced `draft_quest` tool call, and the quest agent runs a full tool-use loop. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5-5`.

## Connect an AI assistant (MCP)

The MCP endpoint is `https://<your-api>/mcp/` (streamable HTTP). Tools: `list_quests`, `get_quest`, `hold_spot`, `check_my_spot`. The **For AI agents** page in the app has copyable config for Claude Desktop and custom connectors.

## Deploy

`render.yaml` deploys both services on [Render](https://render.com) with one blueprint. Use a [Supabase](https://supabase.com) Postgres connection string for `DATABASE_URL` (Project settings > Database > Session pooler). Tables are created on first start.

To deploy the frontend on Vercel instead, import the repo with root directory `frontend` and set `NEXT_PUBLIC_API_URL`. The backend's CORS rules already allow `sidequest*.vercel.app`.

Keep `DEMO_MODE=1` for judging. It turns on one-click personas and the demo controls.

## For judges: a two minute tour

1. Open the hero quest, **Apple picking and cider**. You start as **Leo**. Four of five people are in.
2. Click **Hold $81.00 with PayPal** and approve. Seat 5 fills, the board flips to **IT'S ON**, and the money route moves to *Quest tips*.
3. Switch to **Hon** (top right). Hon is the host. Click **Lock and charge everyone**. Every hold is captured at the final split.
4. Open **Breakneck Ridge**. It's locked, and Leo is on standby. Switch to **Dev** and tell the agent "I can't make it anymore". Switch to **Ana**, the host, and approve the swap. Leo is charged, Dev is refunded, and every PayPal call shows up in the money log.
5. As Ana, use **Settle up** with a higher total. Sidequest drafts a PayPal invoice for each person through the Agent Toolkit. Approve them, then click **Trip done** to pay yourself out.
6. Use **Demo controls** (bottom left) to add people or jump to a deadline on any quest.

## Tests

```bash
cd backend
python -m pytest tests/test_flow.py        # full money lifecycle, webhooks, MCP
python -m pytest tests/test_agent_wire.py  # Claude tool loop through the real SDK, on a fake transport
```

Run the two files separately. Each sets its own environment.

## Project layout

```
backend/
  main.py                 FastAPI app, scheduler, MCP mount
  app/engine.py           Quest lifecycle. Every money move goes through here.
  app/paypal/gateway.py   Orders, Payments, Payouts, Webhooks (sandbox and mock)
  app/paypal/toolkit.py   PayPal Agent Toolkit tools, adapted for Claude
  app/agent/builder.py    One sentence to a quest draft
  app/agent/keeper.py     The quest agent and its guarded tools
  app/mcp_server.py       Sidequest as an MCP server
  app/pricing.py          The split
  scripts/check_sandbox.py
frontend/
  src/app/                Departures, quest page, builder, holds, agents
  src/components/         Ticket, departure board, seat map, money route, agent panel
```

## License

MIT
