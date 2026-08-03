-- RoboRally web server schema (MariaDB 10.5+)
--
-- Storage model: snapshot plus event log.
--
--   games.state_json  is the authoritative game state. It is whatever the
--                     engine produced, stored verbatim.
--   game_actions      is an append-only record of every input fed to the
--                     engine, in order, so any game can be replayed.
--
-- Three things this schema does deliberately, each explained at the column:
--   * the composed grid is NOT stored (see games.state_json)
--   * the RNG's current state is stored, not just its seed (see games.rng_state)
--   * actions are stored with an explicit codec (see game_actions.action_json)

SET NAMES utf8mb4;

-- ============================================================
-- Board library
-- ============================================================

-- One row per converted board.json. Courses pin a board by sha256, so a
-- board being regenerated never shifts a course that is already in play.
CREATE TABLE boards (
  id            VARCHAR(64)  NOT NULL,          -- e.g. 'Hairpin2'
  sha256        CHAR(64)     NOT NULL,          -- of the canonical board.json text
  width         SMALLINT UNSIGNED NOT NULL,
  height        SMALLINT UNSIGNED NOT NULL,
  board_json    LONGTEXT     NOT NULL,          -- the board.json as produced by tmx2board.pl
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, sha256),
  KEY idx_boards_sha (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Accounts
-- ============================================================

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,          -- argon2id or bcrypt; never a raw password
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id            CHAR(36)     NOT NULL,          -- opaque session token (uuid)
  user_id       BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Courses
-- ============================================================

-- An authored course: board placements, optional dock, flags, life tokens.
-- This is the `Course` object from types.ts, stored as authored (NOT
-- flattened). The composer turns it into a ComposedGrid at load time.
CREATE TABLE courses (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(128) NOT NULL,
  course_json   LONGTEXT     NOT NULL,          -- Course: { boards, dock, flags, lifeTokens }
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Bumped whenever the course is relinked to newer board versions. The
  -- server keys its composed-grid cache on this, so a board fixed and
  -- relinked mid-game takes effect without restarting Node.
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                             ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_courses_creator (created_by),
  CONSTRAINT fk_courses_user FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Games
-- ============================================================

CREATE TABLE games (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id     BIGINT UNSIGNED NOT NULL,
  status        ENUM('lobby','active','finished','abandoned') NOT NULL DEFAULT 'lobby',

  -- Authoritative state: the engine's GameState with `grid` OMITTED.
  -- The grid is ~40KB per board and is recomputed deterministically by
  -- composeCourse from courses.course_json, so storing it would mean
  -- writing six figures of unchanging bytes on every single advance.
  -- Contains: robots, deck, turnNumber, phase.
  state_json    LONGTEXT     NULL,

  -- The seeded PRNG. `seed` is kept for the record; `rng_state` is what
  -- actually matters. A seeded generator advances its internal state as it
  -- is consumed, and the engine takes the generator per `advance` call.
  -- Rebuilding it from `seed` on each HTTP request would replay the same
  -- numbers every turn, so the server reconstructs from `rng_state` and
  -- writes the new state back in the same transaction as state_json.
  -- mulberry32 and similar 32-bit PRNGs fit in this column exactly.
  seed          INT UNSIGNED NOT NULL,
  rng_state     INT UNSIGNED NOT NULL,

  -- Denormalised from state_json purely so the lobby can list and filter
  -- games without parsing every snapshot. Written from the same values on
  -- each advance; state_json remains the source of truth if they disagree.
  turn_number   INT UNSIGNED NOT NULL DEFAULT 0,
  phase_kind    VARCHAR(32)  NULL,

  -- Optimistic concurrency. Every advance requires the version the client
  -- (or the request handler) last saw, and increments it. Two simultaneous
  -- submissions cannot both commit; the loser retries against fresh state.
  version       BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- On the Clock. NULL when no timer is running. The server compares
  -- against this on each request and on a sweep, and calls advance with
  -- timerExpired when it has passed.
  phase_deadline DATETIME    NULL,

  winner_user_id BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  finished_at   DATETIME     NULL,

  PRIMARY KEY (id),
  KEY idx_games_status (status, updated_at),
  KEY idx_games_deadline (phase_deadline),
  KEY idx_games_course (course_id),
  CONSTRAINT fk_games_course FOREIGN KEY (course_id) REFERENCES courses (id),
  CONSTRAINT fk_games_winner FOREIGN KEY (winner_user_id) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_games_creator FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who is playing which robot. `robot_id` is the engine's RobotState.id, so
-- this table is the only place a database identity meets an engine identity.
CREATE TABLE game_players (
  game_id       BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  robot_id      VARCHAR(64)  NOT NULL,          -- matches RobotState.id in state_json
  seat          TINYINT UNSIGNED NOT NULL,      -- 1..8, join order
  display_name  VARCHAR(64)  NOT NULL,
  colour        VARCHAR(16)  NULL,
  joined_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, user_id),
  UNIQUE KEY uq_game_robot (game_id, robot_id),
  UNIQUE KEY uq_game_seat (game_id, seat),
  KEY idx_gameplayers_user (user_id),
  CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_gp_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Event log
-- ============================================================

-- Append-only. Every input handed to `advance`, in order. Together with
-- the course and the starting seed this is enough to replay a game exactly.
CREATE TABLE game_actions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_id       BIGINT UNSIGNED NOT NULL,
  seq           INT UNSIGNED NOT NULL,          -- 1-based, dense, per game
  user_id       BIGINT UNSIGNED NULL,           -- NULL for server-driven advances

  -- The GameInput, encoded. NOTE: GameInput carries Map objects in six
  -- places (announcements, chopShopChoices, radioactiveWasteDrawChoices,
  -- facingChoices, repairChoices, continuePowerDownChoices,
  -- returnPowerDownChoices). JSON.stringify turns a Map into {} without
  -- erroring, so this column MUST be written through a codec that converts
  -- Maps to arrays of [key, value] pairs and back. Storing a raw
  -- JSON.stringify of a GameInput silently loses every player choice.
  action_kind   VARCHAR(32)  NOT NULL,          -- deal | program | powerDown | ...
  action_json   LONGTEXT     NOT NULL,

  -- Engine output for this action. Not required for replay (it can be
  -- recomputed) but kept so the client log panel and post-game review do
  -- not need to re-run the engine.
  events_json   LONGTEXT     NULL,

  -- Client-supplied idempotency key. A retried submission with a key
  -- already present is a no-op returning the original result, so a flaky
  -- connection cannot double-submit a program.
  client_token  CHAR(36)     NULL,

  phase_before  VARCHAR(32)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_actions_seq (game_id, seq),
  UNIQUE KEY uq_actions_token (game_id, client_token),
  KEY idx_actions_game (game_id, id),
  CONSTRAINT fk_actions_game FOREIGN KEY (game_id) REFERENCES games (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_actions_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pending submissions during the Program phase. The engine's Program phase
-- accepts submissions piecemeal and reports who is still outstanding, so
-- these accumulate here until every player has submitted or the timer
-- expires, at which point one `advance` consumes them all.
--
-- Kept separate from game_actions because these are not yet inputs to the
-- engine: a player may replace their submission until the phase closes.
CREATE TABLE pending_submissions (
  game_id       BIGINT UNSIGNED NOT NULL,
  robot_id      VARCHAR(64)  NOT NULL,
  turn_number   INT UNSIGNED NOT NULL,
  submission_json LONGTEXT   NOT NULL,          -- ProgramSubmission
  submitted_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id, robot_id, turn_number),
  CONSTRAINT fk_pending_game FOREIGN KEY (game_id) REFERENCES games (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
