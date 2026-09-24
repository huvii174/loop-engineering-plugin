# fixtures/dogfood-epic

A two-item epic for `scripts/loop-close.mjs`: item 1 is `done` with its refined
criteria in `proven.md`; item 2 is `designed` and closing. `verdicts/` holds two
verifier messages for item 2's close — one where every re-run criterion is met,
one where item 2 broke item 1's `Done when:`. Tests copy `.loop/` to the system
temp dir; the fixture itself is never modified (`SHA256SUMS`). Items 5 and 6 of
epic enforce-class-and-epic-integration grow this fixture (D-eci-007).

`real-snapshot/` is this epic's own `.loop/` state (backlog, epic, proven,
rollup) as it stood at item 8's design gate, plus a stand-in `goal.md` for
item 3. It carries the shapes the tidy fixture lacks — row 0, a `C2b` id,
multi-line AC text, escaped `\|` in cells, a 9-column backlog — and
`verdicts/item3-approve-native.md` in the loop-verifier's own
`Criterion: "<Done when>" → met` shape.
