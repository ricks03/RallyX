# Importing boards and courses

Boards are authored outside the web server. `tmx2board.pl` turns a Tiled
`.tmx` into a `board.json`; this tool loads that file into the database.

    export DB_HOST=127.0.0.1 DB_USER=roborally DB_PASSWORD=... DB_NAME=roborally
    node server/dist/import-cli.js board import boards/*.json

---

## Fix and reimport

Boards are keyed `(id, sha256)` and never updated in place. Reimporting a
changed file adds a new version; reimporting an unchanged one does
nothing and says so.

    node server/dist/import-cli.js board import boards/Hairpin2.json
    # new   Hairpin2   4f3a9c1b2e77  12x12

    # ...fix the tmx, regenerate...

    node server/dist/import-cli.js board import boards/Hairpin2.json
    # new   Hairpin2   8b02d45e19aa  12x12

Courses still point at the old version until relinked:

    node server/dist/import-cli.js course relink all
    # relinked   Hairpin Sprint
    #            Hairpin2: 4f3a9c1b2e77 -> 8b02d45e19aa
    #            note: 2 game(s) in play on this course will pick this up immediately

**Games in play pick the change up immediately.** This is intended, not a
side effect: a broken board should be fixable without abandoning games
running on it. The server keys its composed-grid cache on the course's
`updated_at`, so no restart is needed.

Two things to be aware of when relinking mid-game:

- A robot standing where the board changed keeps its coordinates. If a
  cell became a pit, the robot is standing in a pit and will be destroyed
  by the next thing that checks. If the board got smaller, a robot could
  be outside the grid. Neither is guarded against.
- Archive markers are coordinates too, so a respawn point can land
  somewhere different from where it was set.

Neither matters for the usual case of correcting a mislabelled wall.

Old versions stay in the database. Clear out ones nothing references:

    node server/dist/import-cli.js board prune

---

## Course files

A course is a small JSON file you write by hand. `example-course.json`:

```json
{
  "name": "Hairpin Sprint",
  "lifeTokens": 3,
  "dock": null,
  "boards": [
    { "id": "Hairpin2", "gridX": 0, "gridY": 0, "rotation": 0 }
  ],
  "flags": [
    { "number": 1, "board": "Hairpin2", "x": 2, "y": 9 },
    { "number": 2, "board": "Hairpin2", "x": 9, "y": 2 },
    { "number": 3, "board": "Hairpin2", "x": 6, "y": 6 }
  ]
}
```

    node server/dist/import-cli.js course import example-course.json

Notes on the format:

- **No sha256.** The engine's `Course` type requires one on every board
  reference, but writing them by hand would be miserable. The tool
  resolves each board to its newest imported version. Add `"sha256": "..."`
  to a board entry to pin it to a specific version instead, which is
  mostly useful for reproducing an old game.
- **`gridX` and `gridY` are in board units, not cells.** Two boards side
  by side are `gridX: 0` and `gridX: 1`.
- **`rotation`** is optional and defaults to 0.
- **`dock: null` is legal.** With no dock, every player starts on flag 1's
  cell, sharing it. Virtual Mode handles that, including its whole-turn
  grace period on turn 1.
- **Flag coordinates are relative to the named board**, not to the
  composed course, so they do not change when a board is repositioned or
  rotated.
- **Importing a course with a name that already exists updates it** rather
  than creating a second one.

A course is composed at import time, so a mistake fails here rather than
when a player tries to start a game on it.

---

## Commands

    board import <file...>      import or reimport boards
    board list [id]             imported boards and their versions
    board prune                 delete versions no course uses

    course import <file...>     import or update courses
    course relink <id|all>      repoint courses at the newest boards
    course list                 courses
