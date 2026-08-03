# Setting up Apache

Two configs are provided. `apache-roborally-local.conf` is plain HTTP for
the home test box. `apache-roborally.conf` adds TLS and the redirect, for
Linode. The proxy rules are identical in both; only the TLS parts differ.

---

## 1. Enable the modules

    sudo a2enmod proxy proxy_http headers rewrite

Add `ssl` as well on the public server:

    sudo a2enmod ssl

`mod_proxy_wstunnel` is **not** needed. The server uses server-sent
events, which are ordinary HTTP responses held open, so `mod_proxy_http`
carries them. It would only be needed if the transport changed to
websockets.

---

## 2. Switch the MPM. This one actually matters.

Every player watching a game holds one Apache worker open for the whole
game, because that is what an SSE stream is. Under `mpm_prefork` a worker
is a whole process, so eight players in one game is eight processes doing
nothing but waiting.

Check what is running:

    apachectl -V | grep MPM

If it says `prefork`, switch:

    sudo a2dismod mpm_prefork
    sudo a2enmod mpm_event
    sudo systemctl restart apache2

If that fails complaining about PHP, `mod_php` is loaded and it forces
prefork. Either disable it, or move PHP to php-fpm:

    sudo a2dismod php8.2          # whatever version is installed
    sudo a2enmod mpm_event

Then raise the worker ceiling in
`/etc/apache2/mods-available/mpm_event.conf`. The default
`MaxRequestWorkers 150` is the practical cap on simultaneous watchers:

    <IfModule mpm_event_module>
        StartServers             2
        MinSpareThreads         25
        MaxSpareThreads         75
        ThreadsPerChild         25
        MaxRequestWorkers      400
        MaxConnectionsPerChild   0
    </IfModule>

---

## 3. Lay out the files

    sudo mkdir -p /var/www/roborally/public
    sudo mkdir -p /var/www/roborally/boards
    sudo mkdir -p /opt/roborally

    # the built client
    sudo cp -r client/dist/* /var/www/roborally/public/

    # board art from tmx2png.pl
    sudo cp *.png /var/www/roborally/boards/

    # the server
    sudo cp -r server engine package.json /opt/roborally/
    cd /opt/roborally && sudo npm ci --omit=dev && sudo npm run build

    sudo chown -R www-data:www-data /var/www/roborally

---

## 4. Edit the config

In `apache-roborally.conf` (public server) change:

- `ServerName` to the real hostname
- both `SSLCertificate*` paths, if not using certbot's default layout

In `apache-roborally-local.conf` (home box) usually nothing needs
changing. If port 80 is already taken by the default site, uncomment the
`Listen 8080` line and change `<VirtualHost *:80>` to `*:8080`.

Both assume:

- the client is at `/var/www/roborally/public`
- board images are at `/var/www/roborally/boards`
- Node listens on `127.0.0.1:3001`

---

## 5. Enable it

    sudo cp deploy/apache-roborally-local.conf /etc/apache2/sites-available/
    sudo a2ensite apache-roborally-local

    # turn off the default site if it would otherwise answer first
    sudo a2dissite 000-default

    sudo apachectl configtest
    sudo systemctl reload apache2

`configtest` must say `Syntax OK` before reloading. A reload with a broken
config leaves the old one running, which is easy to mistake for the new
one working.

---

## 6. Start the Node process

    sudo useradd --system --home /opt/roborally --shell /usr/sbin/nologin roborally
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
    sudo journalctl -u roborally -f

---

## 7. Check it works

Node directly, bypassing Apache:

    curl http://127.0.0.1:3001/api/health

Through Apache:

    curl http://localhost/api/health

Both should return `{"ok":true}`. If the first works and the second does
not, the problem is the proxy config, not the server.

The SPA fallback, which should return HTML and not a 404:

    curl -I http://localhost/games/1

The SSE stream. This should sit open and print a `: ping` every 20
seconds. If it prints nothing at all, or everything arrives at once when
you interrupt it, the flush settings are not taking effect:

    curl -N http://localhost/api/games/1/stream

---

## Things that go wrong

**The stream connects but no events arrive.** Buffering, almost always
compression. Check the `<Location /api/games>` block with `no-gzip` and
`proxy-sendchunked` is present, and that nothing else is compressing:
disabling deflate confirms it quickly, and it can go back on afterwards
with an exclusion for the stream.

Note that `flushpackets=on` is NOT the fix, despite appearing in a lot of
advice. Apache scopes it to mod_proxy_ajp, _fcgi, _scgi and _uwsgi, not to
mod_proxy_http.

**The stream dies after 60 seconds.** The `timeout=3600` on the
`ProxyPassMatch` is missing or the rule is not matching. Remember the SSE
rule must come BEFORE the general `/api` rule; first match wins.

**Signed in, but every request comes back 401.** The session cookie is not
coming back. On the TLS config this is usually `X-Forwarded-Proto` missing,
so express does not know the request was https. On the local config it is
usually the opposite: `X-Forwarded-Proto https` set on a plain-http vhost
makes the cookie `secure`, and the browser then refuses to send it.

**502 from Apache.** Node is not running, or not on 3001. Check
`systemctl status roborally` and `journalctl -u roborally -n 50`.

**Everything is slow once a few games are running.** Almost certainly the
MPM. See step 2.
