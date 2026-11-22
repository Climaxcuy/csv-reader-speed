[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Climaxcuy/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Climaxcuy/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# csv-reader-speed — event-index scanner

A fast reimplementation of the csv-reader 1.0.0 semantics for the
csv-reader-speed-01 bounty: BOM handling, LF/CRLF record ends, blank-line
skipping, stray-CR reporting, quoted fields with doubled quotes and CR/LF
translation, junk after a closing quote, unterminated-quote recovery, and
the short/long row width policy — bit-for-bit the same answers, produced
by a very different machine.

## How it works

Most CSV parsers walk the text one character at a time and make a decision
per character. This one splits the work into two passes so that the
decision-making pass only ever looks at the characters that matter.

**Pass A — event indexing.** A single `charCodeAt` sweep scans the text
without parsing anything. It only notes the positions of the four
characters a CSV parser can ever branch on — comma, double quote, LF and
CR — and appends them to two parallel, geometrically growing
`Uint32Array`s: one for positions, one for the character codes themselves
(the code doubles as the event class). Everything else in the text is
payload that no branch will ever inspect, and it is never touched again
except by `slice()`.

**Pass B — event-driven parse.** The parser walks the event list, not the
text. Between two consecutive events lies a run of ordinary characters, so
field boundaries, quote opening and closing, `""` escapes (two quote
events at adjacent positions), CRLF pairs (a CR event immediately followed
by an LF event) and record ends are all decided from event positions and
classes. Field values come from `slice()` over the untouched runs; a field
is stitched from several slices only when an event inside it actually
changes the bytes — a stray CR being dropped, a doubled quote collapsing
to one, or a CR/CRLF inside quotes becoming a single `\n`. Line numbers,
row indices and the error list are all computed in this pass from the
events consumed.

The one place the parser ever moves backwards is the unterminated-quote
rule: if a quoted scan reaches the end of the text without closing, the
opening quote turns into a literal character and the text after it is
re-read as an unquoted field. Pass B handles that by restoring the event
cursor with a binary search over the position array and resetting the
line counter to the line the quote opened on, so the newlines counted
during the aborted scan are discarded exactly as the semantics require.

## Layout

- `solve.js` — the parser (`run(input)` → `{columns, rows, errors}`),
  including a small import-time self-warmup that runs a synthetic
  all-paths input a few dozen times so the JIT tiers the hot loops before
  the first real case arrives. `run` keeps no state between calls.
- `main.ts` — the harness driver: reads `cases.json` from
  `MAKEFUN_INPUT_DIR` (default `/input`), stringifies each answer
  separately so the answer graphs never coexist on the heap, and writes
  `answers.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`).
