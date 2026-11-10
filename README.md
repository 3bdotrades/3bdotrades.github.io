# Funded Slots Roadmap

One static page: how many prop-firm evals to buy per firm today, what they cost, and the cash plan for the next 12 weeks.

Live page: https://3bdotrades.github.io/ (G1), https://3bdotrades.github.io/?fleet=v2 (V2 fleet) and https://3bdotrades.github.io/?fleet=sim (Simulation).

Everything about a fleet is read from the fleet dashboard each time the page opens: its account counts, its eval signals and its Lifetime table. The Live rates are that Lifetime table: evals passed of those finished, funded accounts that reached profit of those finished, and flip days won on 50K and on 25K accounts. The plan never holds more evals than the fleet's highest number of eval signals in a day. Prices and payouts are set in `index.html`. The rates you type, the firms you untick and what you enter in the simulation are remembered in your own browser.

The Simulation tab starts from zero: tick the firms, type the evals for each one or a total, pick the days, and it shows cost, payouts and net with one fleet's rates and signals.
