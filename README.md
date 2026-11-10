# Funded Slots Roadmap

One static page: how many prop-firm evals to buy per firm today, what they cost, and the cash plan for the next 12 weeks.

Live page: https://3bdotrades.github.io/ (G1) and https://3bdotrades.github.io/?fleet=v2 (V2 fleet). Both read their account counts and their eval signals from the same fleet dashboard; the plan never holds more evals than the fleet's highest number of eval signals in a day. Prices and payouts are set in `index.html`. The three rates and the firms you untick are remembered in your own browser.

The Live rates are counted from real results. `tools/track.js` reads the fleet dashboard, compares it with its last look and adds what happened in between: evals passed and failed, funded trades won and lost, flip days won and lost. The job in `.github/workflows/track.yml` runs it every 30 minutes and saves the counts on the `track` branch (`g1.json`, `v2.json`), which the page reads.
