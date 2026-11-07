# Connecting your app to WasteZero

There are two changes: point the base URL at WasteZero, and keep your own provider key in a header. Your provider keeps billing you directly.

## Python (fallback included)

```python
import os
from openai import OpenAI, APIConnectionError, APITimeoutError, InternalServerError

OPENAI_KEY = os.environ["OPENAI_API_KEY"]
wastezero = OpenAI(
    base_url="https://wastezero.tech/v1",
    api_key=os.environ["WASTEZERO_API_KEY"],
    default_headers={"X-Upstream-Authorization": f"Bearer {OPENAI_KEY}"},
    timeout=60, max_retries=0,
)
direct = OpenAI(api_key=OPENAI_KEY)

def chat(feature: str, **kwargs):
    """Goes through WasteZero; if WasteZero can't be reached, goes straight to OpenAI."""
    try:
        return wastezero.chat.completions.create(extra_headers={"X-WasteZero-Tag": feature}, **kwargs)
    except (APIConnectionError, APITimeoutError, InternalServerError):
        return direct.chat.completions.create(**kwargs)

reply = chat("support-bot", model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
```

## JavaScript / TypeScript (fallback included)

```js
import OpenAI from "openai";

const wastezero = new OpenAI({
  baseURL: "https://wastezero.tech/v1",
  apiKey: process.env.WASTEZERO_API_KEY,
  defaultHeaders: { "X-Upstream-Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
  timeout: 60_000, maxRetries: 0,
});
const direct = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function chat(feature, params) {
  try {
    return await wastezero.chat.completions.create(params, { headers: { "X-WasteZero-Tag": feature } });
  } catch (err) {
    const unreachable = err instanceof OpenAI.APIConnectionError || (err.status >= 500 && err.status !== 502);
    if (!unreachable) throw err;
    return direct.chat.completions.create(params);
  }
}
```

### Why the fallback?
If WasteZero is ever unreachable, your app keeps working by going straight to the provider. The fallback deliberately does **not** catch the 429s WasteZero sends for budget caps, the loop breaker or a pause. Those are protections you asked for.

## Headers

| Header | What it does |
|---|---|
| `Authorization: Bearer wz_…` | Your WasteZero key |
| `X-Upstream-Authorization: Bearer sk-…` | Your provider key. Used for the request and never stored. |
| `X-WasteZero-Tag: support-bot` | The feature name. Gives you spend, budgets and answer reuse per feature. |
| `X-WasteZero-User: <your user id>` | Optional. Enables per-end-user budgets. Stored only as a one-way hash. If omitted, the `user` field in the request is used. |

Every answer comes back with `X-WasteZero-Overhead-Ms`, the delay WasteZero added.

## Settings you control

Read your settings with `GET /v1/wastezero/settings`. Change them with `PATCH /v1/wastezero/settings`, for example:

```json
{
  "budgets": { "dailyUsd": 200, "monthlyUsd": 4000, "perTagDailyUsd": { "agent": 50 }, "perUserDailyUsd": 2 },
  "budgetAction": "block",
  "loopBreaker": { "maxRepeats": 20, "windowSec": 60, "action": "block" },
  "spikeAlert": { "factor": 5, "minHourlyUsd": 5, "action": "pause" },
  "alertWebhookUrl": "https://hooks.slack.com/services/...",
  "cacheTags": ["faq"],
  "allowedOptimizations": ["cache"]
}
```

| Endpoint | What it does |
|---|---|
| `POST /v1/wastezero/resume` | Restarts traffic after a pause |
| `GET /v1/wastezero/summary` | Your spend and savings |
| `GET /v1/wastezero/waste-report` | Waste found in your traffic, in dollars per month |
| `GET /v1/wastezero/statement?period=YYYY-MM` | A CSV of every request, with its cost, what it would have cost, and the saving |
