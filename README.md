# Counts behind the Live rates

`g1.json` and `v2.json` hold the counts the [Funded Slots Roadmap](https://3bdotrades.github.io/) shows as its four Live rates while the fleet dashboard carries no Lifetime table.

They are kept by `tools/track.js` on the `main` branch (workflow "Count live rates", twice an hour). It reads every build of the fleet dashboard from the dashboard's public repository and counts on from the last Lifetime table the dashboard showed.

In each file: `counts` is, for each rate, `[won, finished]` (`pass` = evals, `win` = funded accounts' first win, `flip` and `flip25` = flip days on 50K and on 25K accounts); `base` is the Lifetime table the counting started from; `log` lists what was counted since, and when (UTC).
