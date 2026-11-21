# Sokoban Solver — push-optimal, room by room

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/musemosmouses/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/musemosmouses/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121): one run answers 5 levels, each in as few pushes as possible.

## How it works

A level is a hallway with one to four rooms off it, and a box pushed out of a room can never come back — so every room is solved on its own and the answers are joined with walks through the hallway. Inside a room the search is A* over pushes: a state is the boxes plus the player's reachable region, each push costs one, and the estimate is the cheapest matching of boxes to goals over true floor distances (admissible, so the first solution found is push-optimal). Dead squares and frozen 2 x 2 blocks are pruned. A plain breadth-first search over pushes is the fallback when A* spends its node budget. Everything is budgeted by nodes expanded, never by the clock, so two runs write the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` for each instance and writes `/output/<id>/solution.txt` (moves in LURD).
