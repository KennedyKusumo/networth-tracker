# Networth Tracker — Feature Roadmap

> Last updated: 2026-04-19 (Phase 4 added: pension, career trajectory, property, career move planners)
> Purpose: Reference doc for Claude-assisted development sessions.

---

## Phase 1 · Growth Rate Analytics ← current sprint

Two sub-features, implemented together.

### A — Inline annualized rate (hero section)
Extend the existing hero section that already shows baseline delta.

**What to show:**
- Annualized growth rate (e.g. `+12.4% p.a.`) calculated from baseline milestone to now
- Time elapsed label (e.g. `over 14 months`)
- Toggle: show equivalent **daily** or **monthly** rate

**Calculation:**
```
elapsed_years = (now - baseline.ts) / (365.25 * 24 * 3600 * 1000)
annualized = ((currentTotal / baseline.summary.total) ** (1 / elapsed_years)) - 1
monthly    = ((1 + annualized) ** (1/12)) - 1
daily      = ((1 + annualized) ** (1/365.25)) - 1
```

**Placement:** Sub-row beneath the existing `Δ from baseline` line in the hero card.

**Edge cases:**
- Baseline total is 0 or negative → show "N/A"
- Elapsed < 7 days → skip annualization, just show raw %
- No baseline set → hide this row

---

### C — Period comparison table
New section below the trend chart: **"Period Performance"**.

**Columns:** Period | From date | Net worth then | Net worth now | Change $ | Change % | Ann. rate

**Preset rows (always shown):**
| Row | `fromTs` source |
|-----|----------------|
| 1 Month | `now - 30d` |
| 3 Months | `now - 91d` |
| 6 Months | `now - 182d` |
| Year to Date | Jan 1 of current year |
| 1 Year | `now - 365d` |
| All Time | earliest account `createdTs` |
| Custom baseline | `milestones.find(id === baselineId)` |

**Net worth reconstruction at `fromTs`:**
```js
// For each visible account:
//   balanceAt(acc, fromTs) → amount in native currency → toDisplay()
// Sum assets, subtract liabilities
function networthAt(accounts, excluded, fromTs, toDisplay) { … }
```
This reuses existing `balanceAt()` and `toDisplay()` — no new API calls.

**Ann. rate column:** same formula as Phase 1A but per-row elapsed time.

**UX notes:**
- "Custom baseline" row only shown if a baseline is set
- Rows where `fromTs` predates all account records → show "—" for that row
- Display currency conversion applied at current rates (not historical rates)

---

## Phase 2 · Targets

Set a desired net worth milestone with a deadline. Track progress.

### Data model (new type: `target`)
```
{
  id: string,
  label: string,          // e.g. "Financial independence"
  amount: number,         // in display currency at time of creation
  currency: string,       // display currency when target was set
  targetTs: number,       // deadline timestamp
  createdTs: number,
}
```
Stored via new API calls: `addTarget`, `updateTarget`, `deleteTarget`.

### UI
- **Hero section:** If any target exists, show closest upcoming target with:
  - Progress bar: current / target amount
  - `X% complete · on track / Y months behind`
  - "On track" = projected value at `targetTs` (using current annualized rate) ≥ target
- **Trend chart extension:** Dashed line from today → target point (amount, date)
- **Target management:** Simple list view with add/edit/delete

### Link to Phase 1
The growth rate (Phase 1A) drives the "on track" calculation — no duplicated logic.

---

## Phase 3 · Modelling & Predictions

What-if analysis and trajectory forecasting. Builds on Phases 1 + 2.

### Core engine
A pure function: given `(currentNetworth, growthRate, monthlyContribution, months)` → `projectedValue[]`

### Features
1. **Projection curve** — extend trend chart forward with projected line at current growth rate
2. **Growth rate slider** — adjust assumed annual rate, see projection update live
3. **Monthly contribution input** — "what if I add $X/month?"
4. **Time-to-target** — given a target (Phase 2), calculate: "at current rate, reach it in X years"
5. **Required rate** — given target + deadline, back-solve: "need Y% p.a. to hit it on time"
6. **Scenario comparison** — show 2–3 lines: pessimistic / base / optimistic (e.g. ±2% from current rate)

### Data flow
```
Phase 1 growth rates  →  base rate assumption
Phase 2 targets       →  goal amount + deadline
Phase 3 engine        →  projection curves, time-to-target, required rate
```

### UX notes
- Lives in a new "Model" or "What If" tab/page — separate from Overview to avoid clutter
- All inputs are local state (no persistence needed for v1)
- Milestone-based: no requirement for daily balance tracking

---

## Phase 4 · Life Planning Suite

Four purpose-built planning calculators. All use the Phase 3 projection engine as their computation core. All live under a new **"Plan"** tab/page, each as a collapsible section or sub-tab.

All Phase 4 modules are frontend-only for v1 — inputs are local state, no persistence required.

---

### 4A · Pension Planner

Answer: *"Will my pension be enough, and if not, what changes?"*

**Auto-populated inputs (from existing accounts):**
- Current pension pot value — sum of visible accounts with `class === "retirement"`
- Monthly contribution — user editable (not auto-detected; most pension contributions aren't tracked per-record)

**User inputs:**
- Target retirement age (or date)
- Expected annual growth rate (default: historical rate from Phase 1, editable)
- Target retirement income per year (in display currency)
- Drawdown period in years (default: 25; represents post-retirement lifespan)

**Outputs:**
- Projected pot at retirement (Phase 3 engine: `project(currentPot, growthRate, monthlyContrib, months)`)
- Sustainable annual income = `projectedPot × safeWithdrawalRate` (default 4% rule, editable)
- Gap: `targetIncome - sustainableIncome` → positive = shortfall
- Required monthly contribution to close the gap (back-solve)
- Required growth rate to close the gap (back-solve)
- Timeline chart: pot growth curve + "target pot needed" as horizontal line

**Back-solve formulas:**
```
// Required pot for target income at given withdrawal rate:
requiredPot = targetIncome / withdrawalRate

// Required monthly contribution to reach requiredPot in N months at r growth:
// Uses standard annuity formula: FV = PV*(1+r)^N + PMT*((1+r)^N - 1)/r
// Solve for PMT: PMT = (requiredPot - currentPot*(1+r)^N) * r / ((1+r)^N - 1)
```

**UX notes:**
- "Years to retirement" auto-calculated from DOB or target age input
- All fields editable inline — live recalculation on every change
- Show years to retirement prominently

---

### 4B · Career Trajectory Model

Answer: *"How does my income growth path shape my net worth over time?"*

This extends Phase 3's "monthly contribution" input from a single flat value to a **time-varying schedule** driven by career milestones.

**User inputs:**
- Current gross income
- Savings rate % (of income saved per month, net of tax — editable, default 20%)
- Career milestones: list of `{ date, newSalary, label? }` — e.g. promotions, role changes
  - Add/remove rows in a simple table
  - Can model different trajectories: "stay" vs "move" vs "accelerated"
- Growth rate for invested portion (default: historical rate from Phase 1)

**Outputs:**
- Projected net worth over time — curve showing effect of varying contributions
- Overlaid against flat-contribution Phase 3 baseline for comparison
- "Monthly savings" step chart showing contribution changes at each milestone
- Net worth at key horizon points: 5y, 10y, 20y, retirement

**UX notes:**
- Scenario A / B / C comparison: define up to 3 career paths, overlay on one chart
- All local state — no persistence needed for v1
- The "scenarios" framing here is the foundation for 4C (Career Move Planner)

---

### 4C · Career Move Planner

Answer: *"Should I take this new job — when does it pay off, and how much better/worse am I in 20 years?"*

A focused two-scenario comparison built on 4B's trajectory engine.

**User inputs:**
- **Stay path:** current salary + expected annual raises % 
- **Move path:** new salary + expected annual raises %, transition cost (gap months, moving/retraining costs)
- Savings rate % (shared, or can differ per path)
- Comparison horizon: 5 / 10 / 20 years (toggle)
- Growth rate on invested savings (default: Phase 1 historical)

**Outputs:**
- Side-by-side net worth projection: Stay vs Move
- Break-even point: month/year when Move path overtakes Stay path
- Net worth delta at horizon: "Moving puts you £X ahead / behind in 10 years"
- Cumulative earnings comparison (gross income total over horizon)
- Summary verdict card: "Break-even in 2y 4mo · +£180k net worth in 10y"

**UX notes:**
- Pre-populates "Stay" from current account/income data if available
- Transition cost shown as a one-time net worth dip at move date
- Keeps it to two paths max (vs 4B's three) — decision tool, not explorer

---

### 4D · Property Purchase Planner

Answer: *"When can I afford to buy, and what does it do to my net worth trajectory?"*

**User inputs:**
- Target property price
- Deposit % required (e.g. 20%)
- Purchase costs (stamp duty, legal fees — flat amount or % of price)
- Accounts earmarked for deposit: multi-select from existing cash/savings accounts
  → auto-sums their current balances as "current deposit savings"
- Monthly saving capacity toward deposit (additional, beyond current accounts)
- Mortgage: loan amount (auto-calculated), interest rate %, term years

**Outputs:**

*Before purchase:*
- Deposit needed = `price × depositPct + purchaseCosts`
- Deposit gap = `depositNeeded - currentDepositSavings`
- Months to deposit target at monthly saving capacity
- Target purchase date (from today + months above)

*At purchase (net worth snapshot):*
- Net worth change at purchase: `+property value - mortgage taken on - purchase costs`
- Because `deposit paid out of savings` is offset by `property asset added`

*After purchase:*
- Net worth trajectory: property value at assumed appreciation rate vs shrinking mortgage balance
- Compared against "renting" path: same monthly outgoing as mortgage, invested instead
- Equity milestone labels (e.g. "50% LTV reached in X years")

**Calculation:**
```
// Monthly mortgage payment (standard annuity):
monthlyRate = annualRate / 12
payment = loanAmount * monthlyRate / (1 - (1 + monthlyRate)^(-termMonths))

// Property net worth contribution at month t:
propertyNW(t) = price*(1+appreciationRate)^(t/12) - remainingMortgageBalance(t)
```

**UX notes:**
- "Rent vs Buy" comparison is v2 scope — v1 just shows buy path
- Appreciation rate defaults to a conservative 3% p.a., editable
- Mortgage figures clearly labeled as estimates, not financial advice

---

## Phase 5 · Financial Management Suite

Four tools for actively managing current finances (vs Phase 4's forward-looking scenarios). Phase 5 modules are more operationally focused — used regularly, not just for one-off planning.

New data types required are noted per module. Backend changes needed for persistence are flagged.

---

### 5A · Budget Planner

Answer: *"Where is my money going, and how much am I actually saving?"*

**Data model challenge:** The current app stores balance snapshots, not transactions. Two approaches:

- **v1 — Planning mode only:** pure forward-looking budget. User inputs income + spending categories. App shows how much is left to save. No transaction tracking. Fully frontend, no new backend.
- **v2 — Hybrid:** use month-over-month balance changes in liquid accounts as a proxy for net saving. `impliedSaving = liquidBalanceNow - liquidBalancePrevMonth`. No expense categories, but validates the plan.

**v1 inputs:**
- Monthly net income (manual; or link to Career Trajectory 4B if set)
- Spending categories: list of `{ name, monthlyBudget }` — e.g. Rent, Food, Transport, Subscriptions
- One-off costs: `{ name, amount, date }` — holidays, repairs

**v1 outputs:**
- Budget summary: income − Σ(categories) = projected monthly saving
- Saving rate % — links to Phase 4B savings rate assumption (surface the connection)
- Remaining "unallocated" amount highlighted: money without a plan
- Yearly projection: monthly saving × 12 = annual contribution to net worth
- Shortfall alert: if total budget > income, show deficit

**v2 additions (separate sprint):**
- Actual vs budget comparison using milestone-derived balance changes
- Month picker: compare budget against any past month
- Variance bars: green/red per category (estimated actual vs budget)

**Backend changes (v2 only):** none if using balance-change proxy; full transaction tracking is out of scope.

**UX:** Lives in a "Budget" sub-tab under Plan page. Single-page layout, no navigation needed.

---

### 5B · Family Finances Planner

Answer: *"How do our finances combine, how do we split shared costs fairly, and what are our joint targets?"*

**Scope note:** Full multi-user account sharing is backend-heavy and out of scope for now. v1 is a **calculator / planning tool** — no shared data, no multi-login.

**v1 concept — Household modelling:**
User inputs their household manually. The tool calculates fair splits and combined projections.

**Inputs:**
- Household members: list of `{ name, monthlyIncome, existingNetWorth }`
  (current user's income/net worth auto-populated from app data)
- Shared monthly expenses: `{ name, amount }` — rent, utilities, groceries, etc.
- Allocation method: equal split / proportional to income / custom %

**Outputs:**
- Each person's fair share of shared expenses (per allocation method)
- Each person's remaining disposable income after shared costs
- Combined household net worth (current user's real data + partner's manual input)
- Combined saving capacity per month
- Joint net worth projection using Phase 3 engine on combined figures
- "Who's ahead" tracker: individual net worth contributions over time

**Milestone integration:**
- Save a "household snapshot" milestone tagged as joint — shows combined net worth at that date
- Useful for tracking progress toward joint targets (e.g. house deposit, shared holiday)

**Future v2 — shared access:**
- Invite partner via email; they connect their own account
- Accounts automatically marked as joint vs individual
- Backend: multi-user ownership model on accounts table

**UX:** Collapsible section in Plan page. Input form on left, combined summary on right.

---

### 5C · Mortgage Manager

Answer: *"Which mortgage deal is best, should I overpay, and when should I remortgage?"*

Extends Phase 4D's property planner with lender comparison and ongoing management tools.

**Sub-sections:**

#### Provider Comparison
Compare up to 5 deals side by side.

Per provider inputs: `{ name, initialRate%, revertRate%, productFee, maxLTV%, fixedTermYears, term }`

Comparison outputs (per deal, for a given loan amount):
- Monthly payment during fixed term
- Monthly payment after revert (stress-test view)
- Product fee amortised per month (fee ÷ fixedTermMonths — true cost)
- **Total cost over fixed term** = (monthlyPayment × fixedTermMonths) + productFee
- **True effective APR** including fee
- Capital repaid during fixed term (how much equity built)
- Recommended pick: lowest total cost over fixed term highlighted

```
// True effective monthly rate including fee:
// Solve for r in: loanAmount + fee = Σ payment/(1+r)^t  (Newton-Raphson or bisection)
// Simpler approximation: effectiveRate ≈ (totalPaid / loanAmount)^(1/years) - 1
```

#### Overpayment Calculator
- Current mortgage details: balance, rate, remaining term, max overpayment % (some lenders cap at 10%/yr)
- Monthly overpayment amount (slider)
- Outputs: interest saved total, years cut from term, new payoff date
- Chart: standard amortisation vs overpayment amortisation side by side

#### Remortgage Planner
- Fixed rate end date input
- Alert threshold: "start looking X months before end" (default 3 months)
- LTV at end of fixed term (auto-calculated from amortisation schedule)
- Rate tier lookup: show which LTV bracket unlocks better rates (user-defined tiers)
- "Time to next LTV tier" — months until reaching 60%, 75%, 80% etc.

**UX:** Three collapsible sub-sections within the Mortgage card on Plan page.

---

### 5D · Investment Portfolio Planner

Answer: *"Is my current allocation optimal, and what would a different portfolio look like in 20 years?"*

**Current portfolio data (auto-populated):**
- Pulls from existing accounts with `class === "investments"` or `class === "retirement"`
- Groups by `risk` tag: very-low / low / medium / high / very-high
- Shows current allocation % by risk and class

**Module structure:**

#### Target Allocation Designer
- User defines target portfolio as % split across asset classes:
  `{ cashSavings, bonds, globalEquities, property, alternatives }` (must sum to 100%)
- Preset templates: Conservative (60/40), Balanced (80/20), Growth (95/5), All-Equity
- Gap analysis: current allocation vs target — show over/underweight per category
- **Rebalancing calculator:** given gap, show £ amounts to buy/sell to reach target
  - "Buy £X of global equities, sell £Y of cash" — respects current account balances

#### Portfolio Comparison (What-If)
- Define up to 3 portfolios: Current / Target / Alternative
- Per portfolio: assign expected annual return % per asset class
  - Defaults: cash 1%, bonds 2.5%, global equities 7%, property 4%, alternatives 6%  (all editable)
  - Weighted average portfolio return = Σ(allocation% × expectedReturn%)
- Project each portfolio over 10 / 20 / 30 years using Phase 3 engine
- Outputs per portfolio: projected value, total gain, gain vs current portfolio
- Chart: three projection lines overlaid

#### Risk Profile Summary
- Weighted average risk score (1–5 scale mapped from risk tags)
- Diversification score: penalise concentration (Herfindahl–Hirschman index on allocation)
- "Your portfolio is X% correlated to [risk level]" — simple descriptive label

**UX:**
- Three sub-sections in Investment card on Plan page
- Rebalancing suggestions shown as an action list: "To rebalance: Buy £X in [account class]"
- Clear "these are projections, not advice" disclaimer

---

### 5E · Homeownership Cost Estimator

Answer: *"What does it actually cost to own this property every year — and how much does my willingness to do the work myself change that?"*

This is distinct from 4D (which covers acquisition) and 5C (which covers the mortgage). This module covers the **ongoing running costs** after you own the home. It is the most property-specific tool in the suite, and the most tailored to individual circumstances.

**What makes this unique:**
- Costs vary dramatically by property age, type, and condition
- Labour is 50–60% of most maintenance jobs — DIY willingness is a major cost lever
- Address/location drives council tax, insurance risk profile, and leasehold obligations
- Useful both pre-purchase ("what will this property really cost?") and post-purchase ("am I budgeting enough?")

---

**Inputs — Property profile:**

| Input | Notes |
|-------|-------|
| Property address / postcode | Used for council tax band lookup and flood/subsidence risk flag |
| Property type | Detached / semi-detached / terraced / flat |
| Tenure | Freehold / leasehold |
| Build era | Pre-1900 / 1900–1950 / 1950–1980 / 1980–2000 / 2000+ |
| Size | Bedrooms or sq ft |
| EPC rating | A–G, or estimated from build era + type if unknown |
| Garden | None / small / medium / large |
| Has garage | Yes / No |
| Age of key systems | Boiler age (years), roof last replaced (years ago) — "I don't know" defaults to era average |

**Inputs — Ownership profile:**

| Input | Notes |
|-------|-------|
| Property value | Used for insurance + maintenance % calculations; link from 4D if set |
| Mortgage monthly payment | Auto-populated from 5C if set; else manual |
| Ground rent | Leasehold only; annual £ |
| Service charge | Leasehold only; annual £ |
| DIY willingness | Slider: Never (0%) → Sometimes (33%) → Often (66%) → Always (100%) |

---

**Cost categories and estimation model:**

#### 1. Fixed obligations (no DIY effect)
- **Council tax** — UK: band A–H lookup by postcode via [VOA API](https://www.gov.uk/guidance/council-tax-bands) or manual band entry → multiply by local authority rate (editable, with sensible regional default)
- **Buildings insurance** — estimated from property value × 0.15–0.25% p.a., adjusted for flood/subsidence risk flag
- **Contents insurance** — flat estimate £150–300/yr, user-editable
- **Ground rent + service charge** — leasehold inputs direct

#### 2. Utilities (EPC/size-driven)
Estimated annual costs scaled by EPC rating and bedrooms:

| EPC | Gas/heating index | Electricity index |
|-----|------------------|-------------------|
| A–B | 0.6× | 0.7× |
| C   | 1.0× (baseline) | 1.0× |
| D   | 1.35× | 1.15× |
| E–G | 1.7× | 1.3× |

Baseline (3-bed, EPC C): Gas ~£900/yr, Electricity ~£700/yr, Water ~£450/yr — all editable.

#### 3. Maintenance & repairs (core DIY-variable section)

Base annual maintenance rate as % of property value, by build era:

| Era | Base rate | Rationale |
|-----|-----------|-----------|
| Pre-1900 | 2.5% | Original materials aging, non-standard repairs |
| 1900–1950 | 2.0% | Older systems, likely multiple past owners |
| 1950–1980 | 1.5% | Post-war builds, 50–70 yr old systems |
| 1980–2000 | 1.0% | More standardised, still aging |
| 2000+ | 0.75% | Modern build warranty taper |

**DIY discount applied to labour portion only:**
Labour is ~55% of most maintenance job costs. DIY willingness reduces the labour component:
```
labourFraction    = 0.55
diySaving         = baseMaintenanceCost × labourFraction × diWillingnessSlider
adjustedMaintenance = baseMaintenanceCost - diySaving
```

**Maintenance sub-categories (shown as breakdown):**

| Category | Frequency | Example tasks | DIY-reducible? |
|----------|-----------|---------------|----------------|
| Routine upkeep | Monthly | Cleaning, minor fixes | Fully |
| Decorating | Every 5–7 years | Painting, wallpaper | Fully |
| Garden | Annual | Lawn, hedges, landscaping | Fully |
| Boiler service | Annual | Gas safety check | Partially (service = pro; fixes = DIY) |
| Boiler replacement | Every 10–15 years | New boiler | Partially |
| Roof | Every 20–40 years | Re-tile, repair | No (specialist) |
| Windows/doors | Every 20–30 years | Replace frames | No |
| Plumbing | Occasional | Leaks, radiators | Partially |
| Electrical | Every 10 years | EICR, consumer unit | No (regulatory) |
| Damp/structural | As needed | Damp proofing, underpinning | No |

Boiler and roof age inputs used to uplift costs if replacement is due within 5 years (urgency flag).

#### 4. Emergency / contingency buffer
- Recommended buffer = 1 month's total running costs as liquid reserve
- Shown as: "Keep £X in easy-access savings for home emergencies"

---

**Outputs:**

**Annual cost summary (stacked breakdown):**
```
Mortgage payments         £ X,XXX   [from 5C or manual]
Council tax               £   XXX
Buildings & contents ins  £   XXX
Utilities (gas/elec/water)£   XXX
Maintenance & repairs     £ X,XXX   ← DIY-adjusted
Ground rent / service chg £   XXX   [leasehold only]
─────────────────────────────────
Total annual cost         £XX,XXX
Monthly equivalent        £ X,XXX
```

**DIY sensitivity panel:**
- Show same total at 0%, 33%, 66%, 100% DIY willingness
- "At your current DIY level you save £X/yr vs full professional"
- Highlight the maintenance line as the variable

**True cost of ownership vs renting:**
- Compare against equivalent rental market rate (user inputs local rent estimate)
- Show break-even: "after X years, owning becomes cheaper than renting at this cost level"
- Does not account for equity build-up (that's 4D/5C's job) — purely cash-flow view

**Flags and alerts:**
- 🔴 Boiler >12 years old: budget for replacement within 3 years (~£3,000–5,000)
- 🔴 Roof >25 years: inspection recommended
- 🟡 EPC D or below: energy upgrade could save £X/yr
- 🟡 Leasehold with <80 years remaining: lease extension costs may apply
- 🟡 Flood zone postcode: insurance premium likely above estimate

---

**Address/postcode integrations (UK):**

| Data | Source | Fallback |
|------|--------|----------|
| Council tax band | VOA API (`api.postcodes.io` for LSOA → VOA band lookup) | Manual band selector A–H |
| Flood risk | Environment Agency Flood Map API | Manual toggle |
| Postcode area stats | `postcodes.io` free API | None required |

All external calls are optional — tool degrades gracefully to manual inputs if APIs unavailable or user prefers not to share postcode.

---

**UX:**
- Lives in Plan page as "Home Running Costs" section
- Property profile inputs persist locally (localStorage) — not synced to backend (no sensitive data needed)
- DIY slider is the most prominent interactive element — update costs live
- Show "estimated" badges on all figures; prominent disclaimer: *"These are estimates based on typical costs. Get quotes for major works."*
- Can be used pre-purchase ("what would this property cost me?") and post-purchase (ongoing budget check)
- Link surface: 4D fills in property value + mortgage; 5C fills in mortgage payment; 5A pulls total into monthly budget

---

## Design principles (all phases)

- **Each phase feeds the next** — growth rate → target tracking → modelling. No throwaway work.
- **Milestone-tolerant** — works well with sparse data; don't require daily check-ins.
- **Display-currency aware** — all aggregations respect `toDisplay()` and current FX rates.
- **Exclusion-aware** — respect `excluded` set (hidden accounts/classes) in all calculations.
- **Single-file architecture** — keep adding to `src/App.jsx`; no new component files unless it gets unwieldy.

---

## Implementation order

```
Phase 1A  (hero inline rate)          ✓ done
Phase 1C  (period table)              ✓ done
Phase 2   (targets)                   ← needs new backend API endpoints
Phase 3   (modelling / what-if)       ← frontend-only, depends on 1+2
Phase 4A  (pension planner)           ← depends on Phase 3 engine
Phase 4B  (career trajectory model)   ← depends on Phase 3 engine
Phase 4C  (career move planner)       ← depends on Phase 4B
Phase 4D  (property purchase)         ← mostly self-contained, can be parallel to 4A/4B
Phase 5C  (mortgage manager)          ← extends 4D
Phase 5E  (home running costs)        ← self-contained; optionally links 4D + 5C
Phase 5A  (budget planner)            ← 5E feeds home costs line into budget
Phase 5B  (family finances)           ← standalone; uses Phase 3 engine
Phase 5D  (investment portfolio)      ← depends on Phase 3 engine
```

### Dependency map
```
Phase 1 (growth rates)
    └── Phase 2 (targets)
            └── Phase 3 (projection engine)
                    ├── 4A Pension Planner         (engine + back-solve)
                    ├── 4B Career Trajectory       (engine + time-varying contributions)
                    │       └── 4C Career Move     (two-path 4B comparison)
                    ├── 4D Property Planner        (engine + mortgage annuity)
                    │       ├── 5C Mortgage Mgr    (extends 4D + provider compare)
                    │       └── 5E Home Costs      (running costs; links property value from 4D)
                    └── 5D Investment Planner      (engine + per-asset-class returns)

Phase 1 (period performance)
    └── 5A Budget Planner      (balance-change proxy for actuals; 5E feeds monthly cost into budget)

5B Family Finances             (standalone calculator; uses Phase 3 engine for joint projection)
5E Home Costs                  (mostly self-contained; optional postcode API; DIY slider)
```

### "Plan" page layout (Phases 4 + 5)
New top-nav tab — all sections collapsed by default, expand on click:
```
▼ Pension                    [4A]
▼ Career Trajectory          [4B]
▼ Career Move                [4C]
▼ Property Purchase          [4D]  →  feeds into ↓
▼ Mortgage Manager           [5C]  →  mortgage payment feeds into ↓
▼ Home Running Costs         [5E]  ← DIY slider, postcode, cost breakdown
▼ Budget                     [5A]  ← 5E total feeds in as "home costs" line
▼ Family Finances            [5B]
▼ Investment Portfolio       [5D]
```
