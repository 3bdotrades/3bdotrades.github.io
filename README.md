# Funded Slots Roadmap

One static page: how many prop-firm evals to buy per firm today, what they cost, and the cash plan for the next 12 weeks.

Live page: https://3bdotrades.github.io/ (G1), https://3bdotrades.github.io/?fleet=v2 (V2 fleet) and https://3bdotrades.github.io/?fleet=sim (Simulation).

A fleet's account counts and eval signals are read from the fleet dashboard each time the page opens. The plan never holds more evals than the fleet's highest number of eval signals in a day. Prices, payouts and each size's flip room are set in `index.html`. The rates you type, the firms you untick and what you enter in the simulation are remembered in your own browser.

The four Live rates are counts: evals passed of those finished, funded accounts that reached profit of those finished, and flip days won on 50K and on 25K accounts. When the dashboard carries its Lifetime table, the page reads the counts from it. When it does not, they come from `tools/track.js`: a job (`.github/workflows/track.yml`, twice an hour) that reads every build of the dashboard from its public repository and counts on from the last Lifetime table the dashboard showed (10 Nov 2026, 19:47 UTC). Its counts, and a log of what it counted and when, are in `g1.json` and `v2.json` on the `track` branch.

G1 also holds funded accounts that are not on the dashboard yet (on 10 Nov 2026: two Lucid 50K, two Lucid 25K and one Topstep, set in `index.html`). The same files note every new funded account and every pass the dashboard shows, and the page takes those off the held ones as they come onto the dashboard.

The Simulation tab starts from zero: tick the firms, type the evals for each one or a total, pick the days, and it shows cost, payouts and net with one fleet's rates and signals.
