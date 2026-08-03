# Bringing the server up from nothing

Written for Debian or Ubuntu. On RHEL, Rocky or Fedora the package names
are `httpd` and `mariadb-server`, there is no `a2enmod` (modules are
enabled by dropping a file in `/etc/httpd/conf.modules.d/`), and the vhost
goes in `/etc/httpd/conf.d/` instead of `sites-available`.

Every step ends with a check. Do not go on until it passes: a failure
three steps later is much harder to place than one caught here.

---

## 0. Prerequisites

    node --version        # need 20 or newer
    mariadb --version
    apachectl -v

**Node 20 or newer specifically.** The server uses
`crypto.getRandomValues` for session tokens, which arrived in Node 19.
Distro packages are often older than that; if `node --version` shows 18 or
below, install from NodeSource:

    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs

If MariaDB is missing:

    sudo apt install -y mariadb-server
    sudo mysql_secure_installation

**Check:** all three commands print a version, and Node is 20+.

---

## 1. Database and schema

    sudo mariadb

Then, at the prompt, with a real password:

```sql
CREATE DATABASE roborally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'roborally'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON roborally.* TO 'roborally'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Load the schema:

    mariadb -u roborally -p roborally < schema.sql

**Check:**

    mariadb -u roborally -p roborally -e "SHOW TABLES;"

Eight tables: `boards`, `courses`, `game_actions`, `game_players`,
`games`, `pending_submissions`, `sessions`, `users`.

This schema has never been run against a real MariaDB. If it errors, the
message will name the statement; that is the fastest thing to report back.

---

## 2. Build the server

Work from a copy of the repo anywhere you like for now:

    cd ~/roborally
    npm install
    npm run build

**Check:** `server/dist/main.js` and `server/dist/import-cli.js` both
exist, and `npm test` passes (407 tests).

---

## 3. Run the server by hand, before systemd

Systemd adds a layer that hides errors. Run it in the foreground first:

    DB_HOST=127.0.0.1 DB_USER=roborally DB_PASSWORD=change-me \
    DB_NAME=roborally PORT=3001 \
    node server/dist/main.js

It should print `roborally server listening on 127.0.0.1:3001`.

**Check**, from another terminal:

    curl http://127.0.0.1:3001/api/health

Expect `{"ok":true}`. This is the first time any of `games.ts`,
`http.ts`, `auth.ts` or `timer.ts` has run, so this is where an untested
path is most likely to surface.

Then check the database actually connects, which health does not prove:

    curl -X POST http://127.0.0.1:3001/api/auth/register \
      -H 'Content-Type: application/json' \
      -d '{"username":"rick","password":"a-real-password"}'

Expect `{"ok":true}`. A 500 here means the pool is not reaching MariaDB.

Leave it running for the next step.

---

## 4. Import a board and a course

In another terminal:

    export DB_HOST=127.0.0.1 DB_USER=roborally DB_PASSWORD=change-me DB_NAME=roborally

    node server/dist/import-cli.js board import path/to/Hairpin2.json
    node server/dist/import-cli.js course import server/example-course.json

`example-course.json` uses only `Hairpin2` and `dock: null`, so one board
is enough to get a playable course.

**Check:**

    node server/dist/import-cli.js board list
    node server/dist/import-cli.js course list

The course import composes the course, so if it succeeds the board data
and the flag coordinates are both valid.

---

## 5. Build and place the client

    npm run build --workspace=client

    sudo mkdir -p /var/www/roborally/public /var/www/roborally/boards
    sudo cp -r client/dist/* /var/www/roborally/public/
    sudo chown -R www-data:www-data /var/www/roborally

**Check:** `/var/www/roborally/public/index.html` exists and there is an
`assets/` directory beside it.

---

## 6. Apache

    sudo a2enmod proxy proxy_http headers rewrite
    sudo cp deploy/apache-roborally-local.conf /etc/apache2/sites-available/
    sudo a2ensite apache-roborally-local
    sudo a2dissite 000-default
    sudo apachectl configtest

`configtest` must say `Syntax OK`. Only then:

    sudo systemctl reload apache2

**Check:**

    curl http://localhost/api/health          # {"ok":true}, via the proxy
    curl -I http://localhost/                 # 200, HTML
    curl -I http://localhost/games/1          # 200, not 404 (SPA fallback)

If the first fails but step 3's direct curl worked, the problem is the
proxy config, not the server.

Then the stream, which should sit open and print `: ping` every 20
seconds until you interrupt it:

    curl -N http://localhost/api/games/1/stream

If nothing appears at all, or everything arrives at once on interrupt,
buffering is on: see APACHE.md.

Also switch the MPM now if `apachectl -V | grep MPM` says `prefork`.
Details in APACHE.md, step 2. It will work without this; it will just
hold a whole process per watching player.

---

## 7. Play through it in a browser

Open `http://localhost/`.

1. Sign in as the account from step 3, or create one.
2. The lobby should list `Hairpin Sprint` in the course dropdown. If the
   dropdown is empty, step 4 did not take.
3. Open a new game. You should land in the docking bay screen with
   yourself in bay 1.
4. Press **Start the game**.

Step 4 is the real test: it calls `startPlay`, which builds the robot
roster, finds starting positions, composes the grid and writes the opening
state. It exercises more untested code than anything else here.

Expect it to succeed and then show "This game is running. The board screen
is not built yet." That message is correct — the board screen is the next
piece of work.

**Check** the state actually landed:

    mariadb -u roborally -p roborally -e \
      "SELECT id, status, turn_number, phase_kind, version FROM games;"

`status` should be `active`, `turn_number` 1, and `phase_kind` should be
`awaitingProgram` — the Deal ran and it is waiting for programs.

---

## 8. Only now, systemd

    sudo useradd --system --home /opt/roborally --shell /usr/sbin/nologin roborally
    sudo mkdir -p /opt/roborally
    sudo cp -r server engine package.json package-lock.json /opt/roborally/
    cd /opt/roborally && sudo npm ci --omit=dev && sudo npm run build
    sudo chown -R roborally:roborally /opt/roborally

    sudo tee /etc/roborally.env >/dev/null <<'EOF'
    DB_HOST=127.0.0.1
    DB_USER=roborally
    DB_PASSWORD=change-me
    DB_NAME=roborally
    PORT=3001
    EOF
    sudo chmod 600 /etc/roborally.env

    sudo cp deploy/roborally.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now roborally

**Check:**

    systemctl status roborally
    curl http://localhost/api/health

If it worked by hand in step 3 and fails here, it is almost always the
service file's `WorkingDirectory` or `ExecStart` path not matching where
the files actually are.

---

## Where things go wrong

**Empty course dropdown.** Step 4 did not run, or ran against a different
database than the server is using. Compare the `DB_NAME` in both.

**Signed in, then everything is 401.** The session cookie is not coming
back. On the local plain-HTTP config, make sure nothing is setting
`X-Forwarded-Proto https` — that makes the cookie `secure` and the browser
then refuses to send it over http.

**502 from Apache.** Node is not running, or not on 3001.

**"Start the game" fails.** Read the Node output. The likely candidates
are the course having no flag 1 and no docking bay starts, or a board in
the course not being present at the sha the course pins.
