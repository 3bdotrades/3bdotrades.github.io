# Funded Slots Roadmap

One static page: how many prop-firm evals to buy per firm today, what they cost, and the cash plan for the next 12 weeks.

Live page: https://3bdotrades.github.io/ (G1), https://3bdotrades.github.io/?fleet=v2 (V2 fleet) and https://3bdotrades.github.io/?fleet=sim (Simulation).

A fleet's accounts and eval signals are read from the fleet dashboard each time the page opens: how many evals, funded and flip accounts each firm has, and where each one stands (an eval's profit so far, a flip account's winning days and room). The plan never holds more evals than the fleet's highest number of eval signals in a day. Prices, payouts and each size's flip room are set in `index.html`. The firms you untick and what you enter in the simulation are remembered in your own browser.

The four Live rates cannot be typed: they are the fleet's own counts. Evals passed of those finished, funded accounts that reached profit of those finished, and flip days won on 50K and on 25K accounts. When the dashboard carries its Lifetime table, the page reads the counts from it. When it does not, they come from `tools/track.js`: a job (`.github/workflows/track.yml`, every 10 minutes) that reads every build of the dashboard from its public repository and counts on from the last Lifetime table the dashboard showed (10 Nov 2026, 19:47 UTC). Its counts, and a log of what it counted and when, are in `g1.json` and `v2.json` on the `track` branch. The same counter also runs every 10 minutes as a scheduled task on the owner's PC, for the times GitHub's timer does not start the job; whichever saves a build first, the other finds nothing left to do.

An eval has no fixed length. It trades one day at a time, passes when its profit reaches its target and ends when it loses two days in a row. A winning day is worth half the target (the 50% consistency rule), so it takes at least 2 days; at Tradeify the rule is 40%, so it takes at least 3 and passes less often. The win rate per day comes from the fleet's live eval pass rate.

A flip account pays twice: $1,800 and then half of it on a 50K, $900 and then $450 on a 25K; Tradeify (Select Flex) pays $2,250 and $1,125 first. 3.5% of every payout goes in fees.

G1 also holds funded accounts that are not on the dashboard yet (on 10 Nov 2026: two Lucid 50K, two Lucid 25K and one Topstep, set in `index.html`). The counts files note every new funded account and every pass the dashboard shows, and the page takes those off the held ones as they come onto the dashboard.

The Simulation tab starts from zero: tick the firms, type the evals for each one or a total, pick the days, and it shows cost, payouts and net with one fleet's rates and signals.
