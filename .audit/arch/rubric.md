# Rubric for the architecture bakeoff

Written before reading any candidate. Score each 1-5.

1. **One owner, one path.** Every piece of state has exactly one writer. Button, bar and agent reach the same `run` with no second route. Lists (verbs, tools, hues, ports) are declared once and derived elsewhere.
2. **Pure, testable domain.** Lifecycle, name/hue/port allocation, tiling and parking, grammar (parse/complete/validate/preview), capture filter and annotations are pure functions testable without DOM, workers or timers.
3. **Hot paths.** Capture at thousands of frames per second costs O(1) amortised per frame and one render per animation frame. Terminal output never routes through the store or re-renders components.
4. **Reader load and interface depth.** Small public surfaces, call chains of at most three files for a user action, internals not importable, an agent editing one file does the right thing for the repo.
5. **Fits the runtime and platform.** Realistic integration with the existing worker protocol, LabSwitch and wterm (light DOM CSS, one core per terminal), TypeScript 7, Vite 8, no decorators unless proven.
6. **Incremental delivery.** The build order keeps the app working after each step, each step ends in a named check, and the riskiest unknowns come first.
