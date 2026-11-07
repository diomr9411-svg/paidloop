# Usability and industrial engineering in PaidLoop

The owner of a small firm is the worker here, and getting paid is the production line. So the screens were designed with methods from usability engineering and industrial engineering. Each method below points to something you can see in the app.

**Honest status:** no real users have tested this yet. The test plan is at the end. Times marked "estimate" are calculated, not measured.

## Industrial engineering

| Method | What it means | Where it is in PaidLoop |
|---|---|---|
| Pull system (kanban) | Work is pulled from one list, most important first | "Next steps" on Home: decisions first, then overdue invoices, then drafts, largest amount first |
| Single-piece flow | Finish one job before the next | Approvals shows one card at a time ("1 of 3"), then moves to the next |
| WIP visibility | See what is still waiting | The count on Approvals in the menu, "Also waiting" list, filter counts on Invoices |
| Poka-yoke (error-proofing) | Make the mistake hard or impossible | See the table below |
| Andon | A light shows a problem at once | PayPal status chip with its last check time, and a red bar when PayPal can't be reached |
| Standard work | The same steps every time | New invoice always runs Note, Details, Check and issue, Done |
| Cycle time | Measure how long the process takes | Home shows average days to get paid, the on-time rate, and the measured time from note to issued invoice |
| Aging (WIP age) | Older work needs attention first | "How late is the open money?" on Home |
| Motion economy | Fewer moves, shorter paths | One primary button per step, sticky action bar, date buttons, known customers filled in, tiles link to the filtered list |

### Poka-yoke details

| Mistake | How it is prevented |
|---|---|
| A required invoice field is missing | Issuing is blocked until the legal check passes. "Fix this" opens the exact field |
| Wrong VAT rate | Only 19% and 7% can be chosen. A small business has VAT locked at 0% |
| Sending by accident | Single keys never send anything. After each approval, focus goes to the title, not to a button |
| Issuing the wrong invoice | A summary shows customer, email, language, date and totals before the final click |
| Deleting or cancelling by accident | Dangerous buttons need a second, clearly worded click, and fall back after 8 seconds |
| Clicking twice | Buttons lock while working, so one click makes one invoice |
| The same customer twice | Typing a known name fills in that customer, and saving reuses the record |
| Losing work | An unfinished invoice is kept when you open another page, and drafts can be continued later |
| Wrong number format | 1.234,50 and 1,234.50 both work, and the total updates at once, so a wrong reading is visible |

## Usability review (Nielsen's 10 heuristics)

| Heuristic | In PaidLoop |
|---|---|
| 1. Status is visible | Step marker, PayPal status, "Reading...", messages after each action |
| 2. Matches the real world | "Money you can really spend", not "net liquidity". German and English, with local money and date formats |
| 3. User control | Back on every step, Start over, Decide later, edit a reminder before it goes out |
| 4. Consistency | One blue primary button per step, same status labels on all screens |
| 5. Error prevention | The poka-yoke table above |
| 6. Recognition, not recall | Customer suggestions while typing, date buttons, chat suggestions for customers |
| 7. Flexible and efficient | Keyboard shortcuts (N, I, A, H, ?), Ctrl+Enter, drag and drop, or enter by hand |
| 8. Simple design | Details appear only when needed: known customers collapse, one step per screen |
| 9. Help with errors | Each problem says what is wrong, the law, and how to fix it, in the chosen language |
| 10. Help | "?" shows the shortcuts, and each field has a short hint where needed |

**Fitts's law:** important buttons are large and stay in the same place. On the customer page every target is at least 44 px high, which was measured in the browser.

**Hick's law:** each step has one primary action, and Next steps shows at most 8 items.

**Accessibility:** skip link, visible keyboard focus, labels tied to fields and errors, status never by colour alone (icon and text as well), sound-free messages announced to screen readers, `lang` set on the page, reduced motion respected. This was checked by reading the page structure, not with a screen reader or an accessibility audit tool.

## Effort for the main job

Issuing an invoice from a clear note for a known customer takes 3 actions: read note, check invoice, issue invoice. All can be done by mouse, and the first two also with Ctrl+Enter.

| Step | Estimate with the Keystroke-Level Model |
|---|---|
| Type a 90-character note (0.28 s per key) | 25 s |
| 3 decisions, each with a mental step (1.35 s), pointing (1.1 s) and a click (0.2 s) | 8 s |
| **Total, without reading time and waiting for the system** | **about 33 s (estimate)** |

The app measures the real time for every invoice and shows the average on Home. The times I saw while testing include my test steps, so they are not user results.

## Fast data

Lists, filters and the home screen use database indexes, and files such as PDFs load only when asked for. `backend/test/indexes.test.ts` checks that each main query uses its index, and that a screen runs the same number of queries for 20 rows and 100 rows.

Measured with `npm run benchmark` (in `backend`) on the development laptop: 20,000 invoices, 1,000 customers, about 2 in 100 open, median of 5 requests, in milliseconds. The server was the only thing being tested, so a browser adds its own time. The rules for the screens are in [UI-RULES-APPLIED.md](UI-RULES-APPLIED.md).

| Screen | With indexes | Without |
|---|---:|---:|
| Home screen | 33 | 43 |
| Invoice list, newest | 9 | 14 |
| Invoice list, page 200 | 8 | 13 |
| Filter: overdue | 8 | 17 |
| Filter: paid, sorted by amount | 7 | 65 |
| All, sorted by due date | 7 | 58 |
| All, sorted by customer | 12 | 68 |
| Search by customer | 6 | 54 |
| Search by number | 6 | 53 |
| Approvals | 4 | 11 |
| Audit list | 3 | 7 |

Without indexes, sorting and searching are about 8 to 10 times slower, because every row has to be read. Home and the plain list read few rows, so the gain there is small. These numbers are from the TypeScript server. The earlier Python server was slower in every row (Home 182 ms, list 31 ms) with the same data and the same indexes.

## Test plan with real users (not done yet)

**Who:** 5 people. At least 3 own or run a small firm. At least 2 have German as their first language.

**How:** each person works alone on their own laptop, thinks aloud, and uses the language they prefer. No help unless they are stuck for 2 minutes.

| Task | Success means | Measure |
|---|---|---|
| 1. Turn this note into an invoice: "3 hours heating repair at Müller GmbH at 70 euro, on 2 November" | Invoice issued with correct total | Time, errors |
| 2. Find all overdue invoices | Filter used, list correct | Time |
| 3. Decide the waiting reminder, and change one sentence first | Edited text sent | Time, errors |
| 4. As a customer: ask for more time and accept a plan | Plan active | Time |
| 5. Tell how much money you can really spend, and why it isn't the same as what you received | Correct in their own words | Yes or no |

**After the tasks:** the 10 System Usability Scale questions, then "What was the hardest part?" A SUS score above 68 counts as above average.

**Target:** 4 of 5 people finish each task without help. Every problem found goes on the board with the number of people it affected.
