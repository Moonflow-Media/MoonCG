# External logins: OpenID Connect, Twitch, Discord

People can sign in to MoonCG with an account they have elsewhere. The module `auth-oidc`,
shipped with MoonCG, does it: up to three generic OpenID Connect providers, and presets for Twitch and
Discord. Signing in with user name and password stays as it is.

- [Quick path](#quick-path)
- [The public address and the redirect address](#the-public-address-and-the-redirect-address)
- [OpenID Connect](#openid-connect)
- [Twitch](#twitch)
- [Discord](#discord)
- [Who an account is: linking](#who-an-account-is-linking)
- [The realm of a link](#the-realm-of-a-link)
- [Signing up](#signing-up)
- [What is checked](#what-is-checked)
- [What it is no way around](#what-it-is-no-way-around)
- [When signing in fails](#when-signing-in-fails)
- [The API](#the-api)
- [Writing a provider](#writing-a-provider)
- [What was verified, and what was not](#what-was-verified-and-what-was-not)

## Quick path

1. Tell MoonCG the address people reach it at, unless it is used on this machine only:
   `--public-url https://show.example` (see below).
2. Register an application with the provider. Its redirect address is
   `<public address>/auth/<provider>/callback`, such as
   `https://show.example/auth/twitch/callback`.
3. In the dashboard open **Settings**, find _External logins_, turn the provider on, enter the
   client ID and the client secret, and save.
4. Open **Modules** and enable `auth-oidc`. The login page now has a button for the provider.
5. Let the person sign in once. They are refused, and their account shows on the **Users**
   page under _Sign-in attempts without a user_. Link it to their user there.

Steps 3 and 4 need `system:modules.manage` and `system:settings.manage`, step 5
`system:users.manage`. An administrator holds all of them.

## The public address and the redirect address

A provider sends the browser back to an address that MoonCG tells it, and that you registered
with it. MoonCG builds that address from its **own configuration and never from a request**:
whoever could choose it could have the code of a sign-in delivered to a site of their own.

| Setting            | Flag           | Environment variable | Configuration file |
| ------------------ | -------------- | -------------------- | ------------------ |
| The public address | `--public-url` | `MOONCG_PUBLIC_URL`  | `"publicUrl"`      |

It is an origin: scheme, host and, if it is not the default, the port. No path, no query, no
user name. `https://show.example`, `http://192.168.1.20:9090`.

| Situation                                      | Redirect address                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--public-url https://show.example`            | `https://show.example/auth/<provider>/callback`                                    |
| No public address, opened on this machine      | `http://127.0.0.1:9090/auth/<provider>/callback`, or `localhost`, as you opened it |
| No public address, opened from another machine | None: signing in externally is refused                                             |

- **With a public address**, a sign-in must be started at that address. Opened under another
  name, such as `http://127.0.0.1:9090` on the server itself, the login page still shows the
  button, and pressing it answers that external sign-in is not possible at this address. The
  reason: the cookie that ties the sign-in to the browser is set for the name the browser
  used, and the provider sends the browser back to the public one, where that cookie is not
  sent.
- **Without one**, MoonCG accepts exactly this: the connection comes from this machine, the
  request is addressed to a loopback name (`localhost`, `127.x.x.x`, `[::1]`), and the port is
  the one the server listens on. `X-Forwarded-Host` is never looked at.
- Behind a reverse proxy, set the public address to what people type, and start with
  `--secure-cookies --trust-proxy` as for everything else; see
  [permissions.md](permissions.md#listening-beyond-this-machine).

**An `https://` public address means HTTPS.** A request addressed to it is answered as a
request over HTTPS, whether or not a proxy says so: the cookie of a started sign-in and the
session cookie are `Secure` and carry the `__Host-` prefix, and only a page of the
`https://` origin counts as the server's own. So whatever ends TLS in front of the server
need not be a proxy MoonCG trusts for that. `--trust-proxy` is still what tells clients apart:
without it every request comes from the address of the proxy, and all the limits per address
below count everyone as one. A request under another name, such as `http://127.0.0.1:9090` on
the server itself, is answered as before.

**The proxy must pass `Host` through unchanged.** MoonCG compares the `Host` of a request with
the public address. A proxy that sends its own name for the upstream instead, such as
`127.0.0.1:9090`, makes every external sign-in end with _not possible at this address_
(`/login?error=address`), and makes the server take the pages of the public address for
those of another origin. `X-Forwarded-Host` is never looked at.

| Proxy   | What it sends as `Host` by default | Setting                                               |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| nginx   | The name in `proxy_pass`           | `proxy_set_header Host $host;` in the `location`      |
| Caddy   | The `Host` of the request          | None. Do not set `header_up Host {upstream_hostport}` |
| Apache  | The name in `ProxyPass`            | `ProxyPreserveHost On`                                |
| Traefik | The `Host` of the request          | None (`passHostHeader` is on unless turned off)       |

With nginx, for a server on port 9090 of the same machine:

```nginx
location / {
  proxy_pass http://127.0.0.1:9090;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  # The dashboard and the graphics talk over a WebSocket.
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

**A plain `http://` public address** that is not this machine, such as
`http://192.168.1.20:9090`, is allowed, because installations on a LAN without HTTPS exist.
The server says at its start what that means: the codes of sign-ins and the session cookies
travel unencrypted, and most providers accept only `https://` redirect addresses, with an
exception for `localhost`. Such an installation can therefore often use an external login
only from the server's own machine.

## OpenID Connect

For any provider that speaks OpenID Connect: Keycloak, Authentik, Authelia, Entra ID, Google,
Okta, GitLab, and others. The provider id is `oidc`, so the redirect address is
`<public address>/auth/oidc/callback`.

| Field              | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| Enabled            | Whether the provider is offered                                                       |
| Name on the button | What the login page says after "Sign in with"                                         |
| Issuer             | The address of the provider, **exactly** as it states it itself                       |
| Client ID          | As the provider gave it to you                                                        |
| Client secret      | As the provider gave it to you. Stored, never shown again                             |
| Scopes             | `openid` is always asked for. `profile` adds a name for users that signing up creates |
| Create a user …    | See [Signing up](#signing-up). Off unless you turn it on                              |

**The issuer** is found by discovery: MoonCG reads `<issuer>/.well-known/openid-configuration`,
and what it finds there must name the same issuer, to the letter, including a slash at the
end or its absence. Take the value from the provider's own documentation or from that document
(`"issuer"`). It must be `https://`. The one exception is `http://` to this machine by a
loopback name, for a provider that runs here.

Register the application with the provider as a **confidential web application** using the
**authorization code** flow. MoonCG uses PKCE (`S256`) on top of the client secret; if the
provider asks whether to require PKCE, say yes. A client without a secret (a public client)
works with providers that allow it: leave the secret empty.

**Up to three OpenID Connect providers.** The settings have three sections for the generic
provider: _OpenID Connect_ (id `oidc`), _OpenID Connect 2_ (`oidc2`) and _OpenID Connect 3_
(`oidc3`), each with the fields above and its own client secret. The redirect address of each
is `<public address>/auth/<id>/callback`. They are fixed named slots rather than a list on
purpose: the settings form edits objects, not lists of them, and a secret inside a list item
could not be kept write-only per item. Three slots cover a company directory, a partner's and
one for tests. The first slot is `oidc` as before, so existing settings and links keep working
unchanged. An account is linked per slot: a link of `oidc` is no link of `oidc2`, also when both
point at the same issuer.

## Twitch

Twitch speaks OpenID Connect. The provider id is `twitch`.

1. Register an application in the Twitch developer console (<https://dev.twitch.tv/console>).
2. Give it the redirect address `<public address>/auth/twitch/callback`.
3. Enter its client ID and a client secret in the settings of the module under _Twitch_.

How the console names these fields is Twitch's business and changes; the three values are
what matters.

MoonCG asks Twitch for the scope `openid` and nothing else. No e-mail address is asked for and
none is used. The account is known by its Twitch **user id** (the `sub` of the ID token), which
stays the same when the login name changes. The login name is asked for
(`preferred_username`) only to name the user that signing up creates and to let an
administrator recognize the account.

## Discord

Discord's sign-in is OAuth 2.0 without an ID token, so MoonCG treats it as that and does not
pretend it is OpenID Connect: after redeeming the code, it asks Discord who the access token
belongs to (`GET /users/@me`). The provider id is `discord`.

1. Create an application in the Discord developer portal
   (<https://discord.com/developers/applications>).
2. Give it the redirect address `<public address>/auth/discord/callback` in its OAuth2
   settings.
3. Enter its client ID and its client secret in the settings of the module under _Discord_.

MoonCG asks for the scope `identify` and nothing else: it answers without an e-mail address.
The account is known by its Discord **user id** (a number as text, such as
`80351110224678912`), not by the user name, which can change. The access token is used for
that one request and then dropped.

## Who an account is: linking

An external account belongs to a MoonCG user through a **link**: the pair of provider and the
account's id at that provider (its _subject_), made for the [realm](#the-realm-of-a-link)
the account came from. Nothing else connects them.

- MoonCG **never** takes an account for a user because of its name or its e-mail address. A
  Twitch account called `ada` is not the user `ada`. Names can be chosen freely at most
  providers, and e-mail addresses are not verified by all of them.
- An account without a link is refused, unless [signing up](#signing-up) is on for its
  provider.
- An account is linked to **one** user. Linking it to a second is refused with 409 until it is
  unlinked from the first. A user can have several accounts, also several of one provider.

**Linking, for administrators.** On the **Users** page:

- _Sign-in attempts without a user_ lists the accounts that signed in at their provider and
  were refused here: provider, subject, realm, and what the account calls itself. Choose the
  user and press **Link**. This is the usual way: let the person try once, then link. The
  link is made for the realm the attempt came from.
- Each user has **Link account**: choose the provider and enter the subject, if you know it.
  Such a link has no realm yet and takes the one of the first sign-in.
- Each linked account shows its realm and has **Unlink**.

**An account is its provider and its subject. The name is what the account's owner chose.**
Anybody with a Twitch account can call it `ada` and try to sign in, so the list shows the
name last, marked as what the account calls itself, cut to 64 characters and without
characters that draw nothing or reorder what is drawn (zero-width characters, the
bidirectional overrides), with which a name could be made to read as another. Link an account
only when you know whose it is: ask the person to try at a time you agreed on, or compare the
subject with one they tell you.

The list is kept in memory and is gone after a restart. It holds twenty attempts, one per
account (the latest), and at most five from one address: an address that fills it pushes out
its own entries, and when the list is full, the address with the most entries in it gives one
up. Whoever tries from many addresses with many accounts can still fill it.

Linking an account to a user lets whoever has that account act as the user. So it falls under
the rule for everything about users: with `system:users.manage` you can link and unlink only
for users who hold nothing you do not hold yourself. Someone who manages users but is not an
administrator cannot link their own Twitch account to an administrator.

**Unlinking signs the user out everywhere**, as a new password does. Their password, if they
have one, is untouched.

**A user without a password.** A user that signing up created has no password and can sign in
through the linked account only. An administrator can give them one on the Users page.

## Linking your own account

A signed-in user can link and unlink accounts for themselves on the **Account** page (the name
at the top of the dashboard), which also shows their name and roles and, for a user with a
password, changes it.

**Linking** an account of a provider:

1. The user presses **Link <provider>**. That is a `POST` with a JSON body, which passes the
   origin and forgery checks every request that changes something passes.
2. It takes what signing in takes. A user with a password types it, and a wrong one is counted
   like a wrong current password when the password is changed (and slowed down the same way).
   A request without a password is answered 400 and is not counted.
   **A user without a password** must have signed in within the last **five minutes**: their
   session is the fresh external sign-in that stands in for the password. Sign out, sign in
   again with the account you have, and link within five minutes.
3. The browser goes to the provider, as for signing in, and comes back to the callback. The
   started flow is bound to the **session that started it**: it is finished only by a browser
   that comes back with that session, still valid, and with the ticket of the flow. Another
   user's browser, or the same browser after signing out, gets nothing linked.
4. The account the provider vouched for is linked to the user, for the realm it reports. Then
   the browser goes back to the Account page, still signed in as before.

What is refused, with the reason on the Account page:

- an account that is **linked to another user** (`elsewhere`): it is never moved, by the user
  or by anyone but an administrator who first unlinks it;
- an account the user has already linked **for another realm** (`realm`): it stays bound to
  the realm it was linked for, as at sign-in;
- the **user of dev mode**, a token, and anyone not signed in: only a user in a session of
  their own links accounts to themselves;
- a provider for which self-linking is **switched off** (403).

**Unlinking** one's own account takes the same as linking: the current password (in the JSON
body, `{ "password": "…" }`), or for a user without a password a sign-in of the last five
minutes, so a stolen session cookie alone cannot take a way of signing in away from the user.
It signs the user out everywhere, as when an administrator unlinks. A user **cannot unlink
their only way of signing in**: without a password and without another linked account it is
refused with 409. Set a password or link another account first.

**Switching it off.** On the **Users** page, the _Self-linking_ card switches it for all
providers, and for each provider (`GET` and `PUT /api/v1/self-linking`, with
`system:users.manage`). It is **on** by default: a link a user makes for themselves gives them
nothing they do not hold, since the account signs in as that same user, and it takes the
password or a fresh sign-in, so a stolen session cookie alone does not add a way in. Switch it
off for a provider whose accounts you want to hand out yourself, for example when the realm of
a company directory decides who is who. A stored setting that cannot be read switches it off.

## The realm of a link

The id of a provider, such as `oidc`, is a name in the settings. Which service stands behind
it, the settings say, and settings change. A subject means an account only together with the
service that issued it: the account `12345` of one issuer and the account `12345` of another
are two people. So a provider reports a **realm** with every account, and a link is bound to
it:

| Provider       | Realm                                                 |
| -------------- | ----------------------------------------------------- |
| OpenID Connect | The issuer, exactly as configured and as in the token |
| Twitch         | `https://id.twitch.tv/oauth2`, its issuer             |
| Discord        | `https://discord.com`                                 |

| Link                                               | Sign-in                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Made from the list of attempts                     | Bound to the realm the attempt reported                                      |
| Made by signing up                                 | Bound to the realm of that sign-in                                           |
| Made with **Link account**, or before this existed | Bound to the realm of its first sign-in                                      |
| Bound, and the provider reports the same realm     | Signs in                                                                     |
| Bound, and the provider reports another, or none   | Refused: _This account was linked while the provider was set up differently_ |

**Changing the issuer** of the OpenID Connect provider therefore breaks the links that were
made for the old one, until they are linked again. It does not hand them to the new issuer.
Each refusal is in the log with both realms, and the account shows in _Sign-in attempts
without a user_ with the realm it has now. An administrator who moved the provider on purpose
links it again there, to the same user; that replaces the realm of the link. Linking it to
another user is refused with 409 until it is unlinked from the first.

**The client ID is not part of the realm.** With most providers the subject of a person is
the same for every client, and replacing the client registration at the same issuer must not
cut every link. Where a provider gives each client its own subjects (pairwise subjects, as
Entra ID does), a new client has new subjects anyway: the old links then match nobody, and
nobody else gets them.

The realm is kept with the link in the database (`identities.realm`). A provider of another
module that reports no realm has links without one, which are held to nothing.

## Signing up

Each provider has _Create a user for an account nobody has linked_. It is **off** unless you
turn it on.

| Setting | An account nobody linked                                                      |
| ------- | ----------------------------------------------------------------------------- |
| Off     | Is refused. An administrator links it to an existing user                     |
| On      | Gets a new user **without any role**, and is linked to it. The log records it |

A user without a role holds nothing: no dashboard, no bundle, no graphic. Signing up only
saves the administrator the step of creating the user; they still decide what the user may
do, by giving them roles on the Users page.

The new user is named after what the provider calls the account, cleaned up to what a user
name may be. If that name is taken, it gets a number: `ada-2`. It never becomes the existing
user of that name.

**Signing up creates at most 20 users an hour**, for all providers together. Whoever comes
after that is refused like an account nobody linked, shows in _Sign-in attempts without a
user_, and can try again when the hour has passed; the log says that signing up is paused.
Accounts that have a user already sign in as always. The limit is fixed, and it is counted in
memory, so a restart begins anew.

With Twitch and Discord, "on" means: **everyone on Twitch, or on Discord, can create a user
here**. They hold nothing, but they exist, and each sign-in writes to the database. Turn it on
for a company's own OpenID Connect provider, where the provider decides who has an account;
think twice for a public one.

## What is checked

For every provider, by the server:

| Check                                                                                                                              | Against                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `state` is 256 random bits, kept on the server with the PKCE verifier and the nonce                                                | Guessing it                                                      |
| The browser gets a cookie with a ticket for that entry: `HttpOnly`, `SameSite=Lax`, ten minutes, `Secure` and `__Host-` over HTTPS | A sign-in finished in another browser than it was started in     |
| Coming back, the ticket and the `state` must belong to the same entry                                                              | A page of another site sending a browser here with its own code  |
| The entry is deleted when it is looked up, whatever comes of it                                                                    | Using a `state` twice                                            |
| The entry is gone after ten minutes; at most 1000 are kept, ten per address                                                        | Old links, and filling the memory                                |
| An address starts a sign-in at most 30 times a minute, then 429 with `Retry-After`; the provider is not asked                      | Making the server ask the provider without end                   |
| An address that starts an eleventh sign-in loses its own oldest; at 1000, the address that holds the most gives one up             | One address ending the sign-ins others started                   |
| The redirect address comes from the configuration                                                                                  | A code delivered elsewhere                                       |
| Where the browser goes afterwards (`returnTo`) must be a path of this server                                                       | A link to MoonCG that ends on another site                       |
| Returns from one address that open no session: 20, then refused for 5 seconds, doubling up to 15 minutes                           | Trying codes, and making the server ask the provider without end |
| The provider is given 15 seconds                                                                                                   | A provider that never answers                                    |

For OpenID Connect, by the module:

| Check                                                                       | Against                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| The issuer and every endpoint it names are `https://` (or loopback)         | Secrets and tokens crossing the network unencrypted      |
| The discovery document names the configured issuer                          | One provider's tokens taken for another's                |
| The ID token's signature, with the provider's published keys                | A forged token                                           |
| Only asymmetric algorithms; never `none`, never an HMAC                     | A token "signed" with nothing, or with the client secret |
| `iss` is the configured issuer                                              | A token of another provider                              |
| `aud` contains the client ID; with `azp`, that is the client ID too         | A token made for another application                     |
| `exp` is there and not passed, give or take 30 seconds                      | An old token                                             |
| `nonce` is the one of this sign-in                                          | A token of another sign-in, replayed                     |
| PKCE: the code is redeemed with the verifier of the challenge that was sent | A stolen code redeemed by someone else                   |
| Redirects of the provider's endpoints are not followed                      | A request with a secret handed on to another host        |

A return that opens no session counts, whatever the reason: a wrong `state`, a provider
that refused, an account nobody linked, a disabled user, a wrong realm. Only a sign-in that
worked is taken back off the count. The limits are per address as the server sees it; behind
a proxy that is the address of the proxy unless the server was started with `--trust-proxy`.

**The log** has a line for every external sign-in (the user, the provider, the subject, the
address), for every link and unlink (who did it, the account, the user, the realm), for every
refusal with its reason, and for every user signing up created.

**Nothing of the provider is kept.** No access token, refresh token or ID token is stored or
logged, and none is sent to a browser. The link is a provider, a subject and a realm. The client
secret is a secret of the module's configuration: stored in
`data/config/modules/auth-oidc.json`, never shown, and taken out of every log line.

**The session** an external sign-in opens is the one a password opens: the same cookie
(`mooncg_session`, `HttpOnly`, `SameSite=Lax`, `__Host-` and `Secure` over HTTPS), the same
seven days of idleness and thirty days at most, ended by the same things: signing out, a new
password, disabling the user, and unlinking the account.

**The callback is a `GET` without the forgery header.** Every other request that changes
something needs JSON or `X-MoonCG-CSRF`; this one cannot carry either, because the provider
sends the browser there. `state` stands in for it, as described above. The cookie is
`SameSite=Lax` and not `Strict` because this request is a navigation another site started, and
the browser must still send the cookie.

**The login page** keeps its Content-Security-Policy to the letter. The buttons are links to
`/auth/<provider>/start`, not forms: the policy says `form-action 'self'`, which browsers
apply also to where a form is redirected to, so a form that ends at a provider would be
blocked. Nothing is loaded from a provider. The icon is a file this server serves, and no
provider's logo is shipped.

## What it is no way around

- **The first-run setup.** While the installation has no user, no external account signs in
  or up, whatever the settings say. Otherwise the first Twitch account to come by would end
  the setup with a user who holds nothing. Create the first administrator as before.
- **Disabled users.** A disabled user is refused with every account.
- **Dev mode.** The user dev mode creates cannot be linked (409), and nothing signs in as it.
- **Roles.** Signing in externally gives nobody a role.
- **The module switch.** Disabling `auth-oidc` takes the buttons away, and a sign-in that was
  under way when it was disabled ends with 404. The links stay and work again when it is
  enabled.

**Changing the issuer** of the OpenID Connect provider while accounts are linked does not
hand those links to the new issuer: each is bound to the [realm](#the-realm-of-a-link) it was
made for and is refused until an administrator links it again. The settings of a module still
decide whom the server believes, which is why they need `system:modules.manage` on top of
`system:settings.manage`.

## When signing in fails

The browser ends on the login page with a short message. The reason is in the server log, for
whoever runs the installation; the browser is never told what a provider said.

| Message on the login page                                         | Meaning                                                                        | Look at                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Signing in did not finish …                                       | The `state` was unknown, used, older than ten minutes, or from another browser | Try again; cookies must be allowed            |
| The provider did not confirm who you are                          | The provider refused, could not be reached, or sent a token that is not valid  | The log: `Signing in with "…" was refused: …` |
| This account is not linked to a user here                         | No link, and signing up is off or has created its 20 users of this hour        | The Users page                                |
| This account was linked while the provider was set up differently | The link is bound to another realm than the provider reports                   | [The realm of a link](#the-realm-of-a-link)   |
| This user may not sign in                                         | The user is disabled                                                           | The Users page                                |
| This installation has no user yet                                 | The setup was not done                                                         | The setup URL in the log                      |
| … not possible at this address                                    | The request did not come to the public address, or the proxy rewrote `Host`    | `--public-url`, and `Host` at the proxy       |

Typical lines in the log:

| Line                                                                  | Cause                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `The provider says its issuer is "…", not "…"`                        | The issuer in the settings is not exactly the provider's         |
| `The token endpoint refused the code (401): invalid_client`           | Wrong client ID or client secret                                 |
| `The token endpoint refused the code (400): invalid_grant`            | Often: the redirect address registered with the provider differs |
| `The ID token is not valid: …`                                        | One of the checks above; the text says which                     |
| `… is linked for the realm "…", and the provider now reports "…"`     | The issuer was changed after the account was linked              |
| `Signing up with "…" is paused`                                       | Signing up created 20 users within an hour                       |
| `Module "auth-oidc" failed: … is enabled but has no client ID`        | A provider was turned on without its client ID                   |
| `Module "auth-oidc" failed: The issuer must be an https:// address …` | As it says                                                       |

When the settings are saved and the module does not start with them, the Settings page says
so at once, with the reason, and the Modules page shows the module as `failed`.

## The API

| Request                                                          | Needs                  | Does                                                         |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `GET /api/v1/auth/providers`                                     | nothing                | The ways to sign in: `local`, and each external provider     |
| `GET /auth/:provider/start?returnTo=/path`                       | nothing                | Starts a sign-in: sets the cookie, redirects to the provider |
| `GET /auth/:provider/callback?state=…&code=…`                    | the cookie and `state` | Finishes it: sets the session cookie, redirects              |
| `GET /auth/:provider/icon`                                       | nothing                | The icon of the provider                                     |
| `GET /api/v1/identities`                                         | `system:users.manage`  | `{ identities, providers, unlinked }`, each with its `realm` |
| `PUT /api/v1/users/:id/identities/:provider` `{subject, realm?}` | `system:users.manage`  | Links an account; 409 if another user has it                 |
| `DELETE /api/v1/users/:id/identities/:provider/:subject`         | `system:users.manage`  | Unlinks it and ends the user's sessions                      |
| `GET /api/v1/me/identities`                                      | a session              | `{ identities, providers, password }` of the user itself     |
| `POST /api/v1/me/identities/:provider/link` `{password?}`        | a session              | Starts linking: sets the cookie, answers `{ url }`           |
| `DELETE /api/v1/me/identities/:provider/:subject` `{password?}`  | a session              | Unlinks one's own account; 409 for the only way in           |
| `GET`, `PUT /api/v1/self-linking` `{enabled, disabledProviders}` | `system:users.manage`  | The switch for self-linking                                  |

`PUT` answers 404 for a provider that is not registered, which is most likely a typing
mistake; `DELETE` works for a provider that is gone, so that its links can be removed. `PUT`
binds the link to `realm` if the request names one, or else to the realm the account reported
when it was refused, if it is still in the list of attempts; without either the link is bound
by its first sign-in. A `PUT` for an account the user has already replaces the realm.
`start` and `callback` answer 404 for a provider that is not registered, and both answer 429
with `Retry-After`: `start` when an address started too many sign-ins, `callback` when an
address came back too often without a session. The settings and the switch of the
module are in [modules.md](modules.md#the-api).

## Writing a provider

A module adds a way to sign in with `ctx.auth.registerProvider`:

```js
import { defineModule } from '@mooncg/sdk/module';

export default defineModule((ctx) => {
  ctx.auth.registerProvider({
    id: 'example', // /auth/example/…, and the name the links are stored under
    name: 'Example', // "Sign in with Example"
    icon: 'icons/example.svg', // optional: an .svg or .png in the module's folder
    allowSignup: false,

    // Where to send the browser. Pass everything on.
    authorize({ state, nonce, codeChallenge, redirectUri }) {
      const url = new URL('https://id.example/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: ctx.config.clientId,
        redirect_uri: redirectUri,
        scope: 'openid',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.href;
    },

    // The browser is back, and the server has checked `state`. Redeem the code, verify what
    // comes back, and say who it is. Throw when anything does not hold.
    async callback({ query, redirectUri, nonce, codeVerifier }) {
      const account = await redeemAndVerify(query.code, redirectUri, nonce, codeVerifier);
      return { subject: account.id, name: account.login, realm: 'https://id.example' };
    },
  });
});
```

The server does what is the same for every provider and must not go wrong: `state`, the nonce,
the PKCE verifier and its challenge, the cookie, single use, the ten minutes, the redirect
address, `returnTo`, throttling, deciding which user the account is, signing up, and the
session. The provider does what differs. It never sees a cookie and never opens a session.

What a provider must get right itself:

- **`subject` is the provider's stable id of the account.** Never an e-mail address, never a
  name. It is what the links are stored by.
- **`realm` says who vouches for the account**: the issuer, or a fixed text for a provider
  that is one service. If the settings of your module decide whom it asks, always report it,
  and derive it from that setting: it is what keeps a link from meaning another account when
  the setting changes. At most 255 characters. See [The realm of a link](#the-realm-of-a-link).
- **Verify what comes back.** For OpenID Connect that is the list under
  [What is checked](#what-is-checked). Use `nonce` and `codeVerifier`; they are there for it.
- **`authorize` must answer an `http(s)` address**, or the sign-in is refused.
- **Throw to refuse.** The message goes to the log, never to the browser. Do not put a token
  or a secret into it.
- **`id`** is lowercase letters, digits and single dashes, not `local`, and not one another
  provider has: a second provider of an id would sign in as the users of the first, so it is
  refused. Do not change it later, or the links are orphaned.

## What was verified, and what was not

**Verified against the providers' documentation in November 2026:**

- Twitch (<https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/>): the issuer
  `https://id.twitch.tv/oauth2` and its discovery document; the scope `openid`; the client
  secret in the form of the token request (`client_secret_post`); `preferred_username` only
  through the `claims` parameter; `nonce` supported; `scope` of the token answer being a list
  and not a text.
- Discord (<https://docs.discord.com/developers/topics/oauth2>, `…/resources/user`): the
  authorization and token addresses; the scope `identify` and `GET /users/@me` answering `id`
  and `username` without an e-mail address; the client credentials in the form.

**Tested here,** against an identity provider that runs in the test: the whole OpenID Connect
flow with signed ID tokens and every check listed above (among them a token without a
signature, one signed with the client secret, and one signed with the provider's public key
used as an HMAC secret), the Twitch preset against a provider
with Twitch's quirks, the Discord preset against one that answers like `/users/@me`, and one
sign-in through a real browser.

**Not tested: the real Twitch, the real Discord, and any real OpenID Connect provider.** That
needs registered applications and accounts. The presets follow the documentation; that they
work against the live services is not established. Two things in particular:

- Twitch's documentation does not say whether it honours PKCE. MoonCG sends the challenge
  anyway, which a provider that does not know it ignores. With Twitch, what protects the
  sign-in is `state`, the nonce and the client secret.
- Discord's documentation mentions PKCE but does not describe the `code_challenge` parameter
  of the authorization request. MoonCG sends it as RFC 7636 has it.

Try a preset with a test account before you rely on it for a show.
