# Bringing the server up on CentOS

Applies to CentOS Stream 9, CentOS Stream 8, Rocky and AlmaLinux. Notes
for CentOS 7 are marked where it differs, but see the warning in step 0.

Use `roborally-centos.conf`, not the Debian configs. Every step has a
check; do not go on until it passes.

**The two things that catch people out on this distribution and do not
exist on Debian at all are SELinux (step 6) and firewalld (step 7).** If
something works locally with curl but not from a browser on another
machine, it is the firewall. If Apache returns 503 while Node is plainly
running, it is SELinux.

---

## 0. Which CentOS

    cat /etc/redhat-release

**CentOS 7 is a problem.** It went end of life in June 2024, so no
security updates, and it ships Apache 2.4.6 and very old Node. It can be
made to work, but everything below gets harder and you would be building
on an unsupported base. If this is a new project, CentOS Stream 9 or Rocky
9 is worth the switch now rather than later.

---

## 1. Node 20 or newer

    node --version

**Node 20 minimum.** The server uses `crypto.getRandomValues` for session
tokens, which arrived in Node 19.

On Stream 9 or Rocky 9:

    sudo dnf module list nodejs
    sudo dnf module enable nodejs:20 -y
    sudo dnf install -y nodejs

If no suitable module stream exists, or on CentOS 7:

    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs      # yum on CentOS 7

**Check:** `node --version` prints v20 or higher.

---

## 2. MariaDB

    sudo dnf install -y mariadb-server
    sudo systemctl enable --now mariadb
    sudo mysql_secure_installation

    sudo mysql

```sql
CREATE DATABASE roborally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'roborally'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON roborally.* TO 'roborally'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

    mysql -u roborally -p roborally < schema.sql

**Check:**

    mysql -u roborally -p roborally -e "SHOW TABLES;"

Eight tables. This schema has never run against a real MariaDB; if it
errors, the message names the statement, which is the useful thing to
report back.

---

## 3. Build

    cd ~/roborally
    npm install
    npm run build
    npm test

**Check:** `server/dist/main.js` and `server/dist/import-cli.js` exist and
407 tests pass.

---

## 4. Run the server by hand

Before systemd, which hides startup errors:

    DB_HOST=127.0.0.1 DB_USER=roborally DB_PASSWORD=change-me \
    DB_NAME=roborally PORT=3001 \
    node server/dist/main.js

**Check**, from another terminal:

    curl http://127.0.0.1:3001/api/health
    # {"ok":true}

    curl -X POST http://127.0.0.1:3001/api/auth/register \
      -H 'Content-Type: application/json' \
      -d '{"username":"rick","password":"a-real-password"}'
    # {"ok":true}

Health alone does not prove the database connects; the register call does.
This is the first time `auth.ts`, `games.ts` and the pool have ever run.

Leave it running.

---

## 5. Import a board and a course

    export DB_HOST=127.0.0.1 DB_USER=roborally DB_PASSWORD=change-me DB_NAME=roborally
    node server/dist/import-cli.js board import path/to/Hairpin2.json
    node server/dist/import-cli.js course import server/example-course.json

`example-course.json` uses only `Hairpin2` with `dock: null`, so one board
gives a playable course.

**Check:**

    node server/dist/import-cli.js course list

---

## 6. Apache and SELinux

    sudo dnf install -y httpd
    sudo systemctl enable --now httpd

Modules are already loaded on this distribution; there is no `a2enmod`.

    httpd -M | grep -E 'proxy_module|proxy_http|rewrite|headers'

All four should be listed. If any is missing, it is commented out in
`/etc/httpd/conf.modules.d/00-proxy.conf` or `00-base.conf`.

Place the client and the config:

    npm run build --workspace=client
    sudo mkdir -p /var/www/roborally/public /var/www/roborally/boards
    sudo cp -r client/dist/* /var/www/roborally/public/
    sudo chown -R apache:apache /var/www/roborally

    sudo cp deploy/roborally-centos.conf /etc/httpd/conf.d/
    sudo apachectl configtest        # must say Syntax OK
    sudo systemctl reload httpd

**Now SELinux, which is the step that will otherwise waste an afternoon.**
By default SELinux forbids httpd from opening network connections, so
every `/api` request returns 503 while Node is running perfectly:

    sudo setsebool -P httpd_can_network_connect 1

If the client files were copied from a home directory they may carry the
wrong context:

    sudo restorecon -Rv /var/www/roborally

**Check:**

    curl http://localhost/api/health     # {"ok":true} through the proxy
    curl -I http://localhost/            # 200
    curl -I http://localhost/games/1     # 200, not 404

If step 4's direct curl worked and this one 503s, it is SELinux. Confirm:

    sudo grep denied /var/log/audit/audit.log | tail -5

Then the stream, which should sit open printing `: ping` every 20 seconds:

    curl -N http://localhost/api/games/1/stream

---

## 7. Firewall

Only needed to reach it from another machine. localhost works without it.

    sudo firewall-cmd --permanent --add-service=http
    sudo firewall-cmd --reload
    sudo firewall-cmd --list-services

Do **not** open 3001. Node binds 127.0.0.1 and should stay unreachable
from outside; Apache is the only way in.

---

## 8. The MPM

Every player watching a game holds one Apache worker for the whole game,
because that is what an SSE stream is.

    httpd -V | grep MPM

CentOS defaults to prefork, where a worker is a whole process. Edit
`/etc/httpd/conf.modules.d/00-mpm.conf`: comment out the prefork
`LoadModule` line, uncomment the event one.

    sudo systemctl restart httpd
    httpd -V | grep MPM        # should now say event

If httpd fails to start afterwards, `mod_php` is loaded and forces
prefork. Move PHP to php-fpm, or revert if you need mod_php for something
else. It will work under prefork; it will just be wasteful.

---

## 9. Play through it

Open `http://localhost/` in a browser.

1. Sign in with the account from step 4.
2. `Hairpin Sprint` should be in the course dropdown. Empty means step 5
   did not take, or ran against a different database.
3. Open a new game; you land in the docking bay in bay 1.
4. Press **Start the game**.

Step 4 is the real test: `startPlay` builds the robot roster, finds
starting positions, composes the grid and writes the opening state. More
untested code runs there than anywhere else.

Expect "This game is running. The board screen is not built yet." That
message is correct.

**Check:**

    mysql -u roborally -p roborally -e \
      "SELECT id, status, turn_number, phase_kind, version FROM games;"

`status` active, `turn_number` 1, `phase_kind` `awaitingProgram`.

---

## 10. systemd, last

    sudo useradd --system --home-dir /opt/roborally --shell /sbin/nologin roborally
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

Note `/sbin/nologin`, not `/usr/sbin/nologin` as on Debian.

**Check:**

    systemctl status roborally
    curl http://localhost/api/health

---

## CentOS-specific things that go wrong

**503 from Apache, Node running fine.** SELinux.
`sudo setsebool -P httpd_can_network_connect 1`. This is the single most
common one.

**403 on the client files.** SELinux context, or ownership. Run
`sudo restorecon -Rv /var/www/roborally` and check the files are owned by
`apache`, not `www-data` — that user does not exist here.

**Works with curl on the box, unreachable from another machine.**
firewalld, step 7.

**`a2enmod: command not found`.** Debian-only. Modules are already loaded;
check with `httpd -M`.

**Config edits appear to do nothing.** On this distribution the file must
be in `/etc/httpd/conf.d/` and end in `.conf`. There is no
`sites-available`, and a file named anything else is silently ignored.
