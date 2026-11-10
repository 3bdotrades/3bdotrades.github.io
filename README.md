# Funded Slots Roadmap

One static page: how many prop-firm evals to buy per firm today, what they cost, and the cash plan for the next 12 weeks.

Live page: https://3bdotrades.github.io/ (G1), https://3bdotrades.github.io/?fleet=v2 (V2 fleet) and https://3bdotrades.github.io/?fleet=sim (Simulation). G1 and V2 read their account counts and their eval signals from the same fleet dashboard; the plan never holds more evals than the fleet's highest number of eval signals in a day. Prices and payouts are set in `index.html`. The rates, the firms you untick and what you type in the simulation are remembered in your own browser.

The Simulation tab starts from zero: tick the firms, type the evals for each one or a total, pick the days, and it shows cost, payouts and net with one fleet's rates and signals.

The Live rates are counted from real results. Each fleet starts from its own counts (`LIVE0` in `index.html`). `tools/track.js` reads the fleet dashboard, compares it with its last look and adds what happened in between: evals passed and failed, funded trades won and lost, flip days won and lost. The job in `.github/workflows/track.yml` runs it every 30 minutes and saves the counts on the `track` branch (`g1.json`, `v2.json`), which the page reads.
