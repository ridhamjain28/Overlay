# Overlay command database — sources and omissions

Database: `overlay-command-db.json` (this folder)  
Validator: `test/overlay/commandDb.validate.test.js`  
Generated: 23 November 2026 (Asia/Calcutta). Research only; no installs or runs on Ridham’s PC.

Rules used: an action is included only when it could be verified from official documentation or long-standing first-party URL/CLI usage (for example a product’s own search URL, or a command Steam writes into its desktop shortcuts). Invented URI schemes and undocumented flags were left out. Prefilling a compose box that still needs the user’s Send/Save click is `risk: "safe"`. Anything that places a call is `risk: "confirm"`.

**Engine encoding.** `{param}` values in `uri` and `url` templates are URI-encoded. Two exceptions are built into the engine:

- **Office URI schemes** (`ms-word:ofe|u|{url}` and the Excel/PowerPoint `ofe`/`ofv` equivalents) leave `:` and `/` unescaped inside the document URI (Microsoft Learn, Office URI Schemes, §1.3). A template can also mark a value raw with `{param:raw}`.
- **CLI paths** (`explorer.exe {path}`, `WINWORD.EXE {path}`, `vlc.exe {path}`, etc.) are passed as argv to the process, never interpolated into a shell string and never percent-encoded.

Google Calendar `{start}` / `{end}` must already be in compact form such as `20261124T170000` or `20261124T113000Z`. The database does not parse “5–7pm” itself.

---

## Sources by app

### Browsers

**Google Chrome** — Launch and open a URL with `chrome.exe` / `chrome.exe {url}`. Chromium/Chrome accept a URL operand and the documented flags `--new-window` and `--incognito`.  
- Chromium flags: https://www.chromium.org/developers/how-tos/run-chromium-with-flags/  
- Well-established Windows executable: `chrome.exe`.

**Microsoft Edge** — `microsoft-edge:` and `microsoft-edge:{url}` are documented as a built-in Windows URI scheme. `--inprivate` is the Edge private-browsing switch used with `msedge.exe`.  
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-app  
- Executable: `msedge.exe`.

**Mozilla Firefox** — Official command-line options include a URL operand, `-new-tab`, `-new-window`, and `-private-window`.  
- https://wiki.mozilla.org/Firefox/CommandLineOptions  
- Executable: `firefox.exe`.

**Brave** — Chromium-based; same URL operand and `--incognito` / `--new-window` pattern as Chrome. Included at that well-established Chromium compatibility, not from a separate Brave URI spec.  
- Executable: `brave.exe`.  
- Chromium flags: https://www.chromium.org/developers/how-tos/run-chromium-with-flags/

### Chat and calls

**Spotify** — The `spotify:` scheme is IANA-registered. Official Spotify developer docs define `spotify:track:`, `spotify:album:`, `spotify:artist:` (and related) identifiers. `spotify:search:{query}` is part of the IANA scheme syntax (`spotify:search:`) and Spotify’s own search-link usage.  
- https://www.iana.org/assignments/uri-schemes/prov/spotify  
- https://developer.spotify.com/documentation/web-api/concepts/spotify-uris-ids  
- https://developer.spotify.com/documentation/ios/tutorials/content-linking (`spotify:` registered by the app)  
- Store package prefix: `SpotifyAB.SpotifyMusic_`.

**WhatsApp (desktop)** — Official Help Center documents `whatsapp://` (open app) and `whatsapp://send?text=` (new-chat composer, pre-filled text). It does **not** document a `phone` query on the custom scheme. Specific numbers use `https://wa.me/...` (see WhatsApp Web).  
- https://faq.whatsapp.com/425247423114725  
- Store package prefix: `5319275A.WhatsAppDesktop_`.

**Telegram** — Official deep-link documentation: `tg://` / `tg://resolve?domain={username}&text={text}` and `https://t.me/{username}`. Draft `text` is pre-entered, not sent automatically.  
- https://core.telegram.org/api/links

**Discord** — Only `discord.exe` launch is included. See *Omitted*.

**Slack** — Official desktop deep links: `slack://open`, `slack://open?team=`, `slack://channel?team=&id=`, `slack://user?team=&id=`. Channel and user links require Slack IDs, not names.  
- https://docs.slack.dev/interactivity/deep-linking/

**Zoom** — Launch via `zoom.exe`. Join via Zoom’s official join URL `https://zoom.us/j/{meetingId}`. The user still confirms joining in the client.  
- https://zoom.us/join  
- https://support.zoom.com/ (join-meeting articles, e.g. KB0059553)  
- `zoommtg://` was **not** included; see *Omitted*.

**Microsoft Teams** — `msteams:` is the official desktop protocol handler. Chat, schedule, and call workflows are official `https://teams.microsoft.com/l/...` deep links. Microsoft recommends the https form unless you are sure the desktop client is installed. Draft `message` stays in the compose box. **Start call** is `risk: confirm` because it starts a call. Schedule-meeting opens a dialog; it is not saved until the user confirms in Teams.  
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-links  
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-workflow  
- Executables: `ms-teams.exe` (new client), `teams.exe` (classic).

### Dev tools

**Visual Studio Code** — Official CLI: `code`, `code {path}`, `code --goto file:line[:character]`, `code --new-window`. Official URI: `vscode://file/{path}:line:column`.  
- https://code.visualstudio.com/docs/configure/command-line

**Cursor** — Official deeplinks: `cursor://anysphere.cursor-deeplink/prompt?text=`. Official docs state the user must review and confirm; deeplinks never auto-execute. Launch via `cursor.exe`. Folder-open CLI was not documented on the pages reviewed.  
- https://cursor.com/docs/reference/deeplinks

**Postman** — Launch via `postman.exe` only (installer executable name). See *Omitted* for URI/CLI automation.

**GitHub Desktop** — Launch via `GitHubDesktop.exe` only. See *Omitted* for URI schemes.

### Built-in Windows apps

**Notepad** — `notepad.exe` and `notepad.exe {path}` are the standard Windows commands.  
- Package prefix for the Store/Win11 Notepad: `Microsoft.WindowsNotepad_`.

**Notepad++** — Official user manual command line: `notepad++.exe [filePath]`, `-nLineNumber`.  
- https://npp-user-manual.org/docs/command-prompt/

**Calculator** — `calc.exe` is the long-standing Windows command to open Calculator.  
- Package prefix: `Microsoft.WindowsCalculator_`.  
- The `calculator:` URI is omitted from actions (no current Microsoft Learn reference located in this review).

**File Explorer** — `explorer.exe`, `explorer.exe {path}`, and `explorer.exe /select,{path}` are standard Windows Explorer command-line usage.  
- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/explorer (Explorer command)

**Windows Settings** — Official `ms-settings:` URI scheme, including:  
`ms-settings:`, `ms-settings:display`, `ms-settings:sound`, `ms-settings:bluetooth`, `ms-settings:network-wifi`, `ms-settings:appsfeatures`, `ms-settings:windowsupdate`.  
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings

**Snipping Tool** — Official current protocol is `ms-screenclip://capture/image?rectangle|freeform|window` and `ms-screenclip://capture/video`. Image capture requires exactly one mode parameter with no value. Redirect/callback parameters were omitted (see *Omitted*).  
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-snipping-tool  
- Package prefix: `Microsoft.ScreenSketch_`.

**Paint** — Classic Paint is launched with `mspaint.exe` / `mspaint.exe {path}`. Windows 11 package prefix `Microsoft.Paint_` is included for matching. `ms-paint:` is Paint 3D, not this app (omitted).

**Photos** — Official built-in scheme `ms-photos:` and `ms-photos:viewer?fileName={fully-qualified path}`.  
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-app  
- Package prefix: `Microsoft.Windows.Photos_`.

**Clock** — `ms-clock:` is the well-established protocol for Alarms & Clock / Clock, widely used in Windows since Windows 10 (Microsoft Q&A and long-standing URI lists). A current dedicated Learn reference page was not found; included as well-established usage.  
- Package prefix: `Microsoft.WindowsAlarms_`.

**Mail** — Official `mailto:` scheme launches the *default* mail app (Windows Mail if it is default) and can prefill an address. Microsoft notes the mail is not sent until the user sends it. Subject/body use the standard `mailto:` query form (`subject`, `body`) from RFC 6068.  
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-app  
- Mail/Calendar package prefix: `microsoft.windowscommunicationsapps_`.

**Windows Calendar** — Launch only, via the well-established `outlookcal:` handler for the built-in Calendar app (same Windows communications apps package). No official event-create parameters were verified.  
- Package prefix: `microsoft.windowscommunicationsapps_`.

### Office

**Word, Excel, PowerPoint** — Launch and local files use the official Office executables `WINWORD.EXE`, `EXCEL.EXE`, `POWERPNT.EXE` with an optional document path (standard Office command-line invocation). Online files use official Office URI schemes `ms-word:` / `ms-excel:` / `ms-powerpoint:` with `ofe|u|{https-url}` (edit) and `ofv|u|{https-url}` (view). Only `http`/`https` document URIs are supported by that scheme.  
- https://learn.microsoft.com/en-us/office/client-developer/office-uri-schemes

**Outlook** — Launch via `OUTLOOK.EXE`. Compose uses official `mailto:` (Outlook if it is the default mail handler). Outlook-specific `/c ipm.note` switches were not re-verified in this session (see *Omitted*).

**OneNote** — The `onenote:` scheme is IANA-registered and used by Microsoft Graph as `links.oneNoteClientUrl` to open the installed client (`onenote:` + a OneNote URL).  
- https://www.iana.org/assignments/uri-schemes/prov/onenote  
- https://learn.microsoft.com/en-us/graph/open-onenote-client

### Media and games

**VLC** — Official VideoLAN command-line usage: `vlc.exe` and `vlc.exe {file-or-stream}`.  
- https://wiki.videolan.org/Command-line_interface/  
- https://wiki.videolan.org/VLC_command-line_help/

**Steam** — The `steam:` scheme is IANA-registered. `steam://` launches the client. `steam://rungameid/{appId}` is the URI Steam itself writes into desktop shortcuts it creates. `steam://store` is a well-established store-home command in the same protocol family. The Valve “Steam browser protocol” wiki could not be fetched (bot-protection), so further subcommands were omitted.  
- https://www.iana.org/assignments/uri-schemes/prov/steam

**Epic Games Launcher** — Official protocol `com.epicgames.launcher`. Store root / product pages: `com.epicgames.launcher://store` and `...://store/product/{slug}`. Launch installed app: `...://apps/{SandboxID:CatalogID:ArtifactID}?action=launch&silent=true`.  
- https://dev.epicgames.com/docs/epic-games-store/protocol-activation

### Notes and design

**Obsidian** — Official URI actions: `obsidian://choose-vault`, `open`, `new`, `search`, `daily`. Parameters `vault`, `file`, `name`, `content`, `query` as documented. Values must be URI-encoded (the engine’s job).  
- https://obsidian.md/help/uri

**Notion** — Official web app only: `https://www.notion.so` and `https://www.notion.so/{pagePath}`. No official `notion://` documentation was found (see *Omitted*).

**Figma** — Official web app: `https://www.figma.com` and file URLs `https://www.figma.com/file/{fileKey}` (Figma’s own file URL shape). No official `figma://` documentation was found (see *Omitted*).

### Web apps

**Google Calendar** — Home: `https://calendar.google.com`. Prefill an unsaved event with Google’s documented template URL:  
`https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE&dates={start}/{end}&text={title}&details={details}&location={location}`.  
Dates are compact instants such as `20230325T224500Z`. The user still clicks Save.  
- https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events

**Gmail** — Home: `https://mail.google.com`. Compose: the long-standing Gmail UI URL `https://mail.google.com/mail/?view=cm&fs=1&to=&su=&body=&cc=&bcc=`. This is well-established first-party Gmail usage (the same URL Gmail’s compose deep links have used for years). It was not found as a current Google API reference page in this review. The message is not sent until the user clicks Send.

**YouTube** — `https://www.youtube.com` and YouTube’s own search form URL `https://www.youtube.com/results?search_query=`.

**Google Search** — `https://www.google.com` and `https://www.google.com/search?q=`.

**Google Maps** — Official Maps URLs (parameter `api=1` required on search/directions).  
Search: `https://www.google.com/maps/search/?api=1&query=`  
Directions: `https://www.google.com/maps/dir/?api=1&origin=&destination=&travelmode=`  
Bare open: `https://www.google.com/maps`.  
- https://developers.google.com/maps/documentation/urls/get-started

**Google Drive** — Home: `https://drive.google.com`. Search uses Drive’s own UI URL `https://drive.google.com/drive/search?q=` (well-established first-party Drive interface).

**Google Docs / Sheets** — Homes: `https://docs.google.com`, `https://sheets.google.com`. New document/spreadsheet: Google’s official short URLs `https://docs.new` and `https://sheets.new` (Google-operated shortcuts that create a new file after sign-in).

**ChatGPT** — `https://chatgpt.com` only (OpenAI’s current web app origin). No official prefill/query documentation was found.

**WhatsApp Web (wa.me)** — Official click-to-chat: `https://wa.me/`, `https://wa.me/{phone}`, `https://wa.me/{phone}?text=`, `https://wa.me/?text=`. Phone numbers are full international digits with no `+`, spaces, or dashes. Text is pre-filled; the user must send.  
- https://faq.whatsapp.com/5913398998672934  
- https://faq.whatsapp.com/425247423114725

**Amazon.in** — First-party site and search form: `https://www.amazon.in`, `https://www.amazon.in/s?k=`.

**Flipkart** — First-party site and search form: `https://www.flipkart.com`, `https://www.flipkart.com/search?q=`.

---

## Omitted

These were requested or commonly assumed, but could not be verified to the bar above, or are easy to get wrong:

1. **Discord `discord://` routes** (`discord://-/channels/...`, user, settings). Discord registers a scheme, but official path documentation was not found (only unofficial community route lists). Launch via `discord.exe` is included.

2. **WhatsApp `whatsapp://send?phone=`** (and `whatsapp://call`). Official FAQ documents `whatsapp://send?text=` and `https://wa.me/{number}` for a specific number, not a `phone` parameter on the custom scheme.

3. **GitHub Desktop URI schemes** (`x-github-client://`, `github-windows://`, current successors). A GitHub Desktop issue describes `x-github-client` as a legacy scheme after Desktop 1.0. Current official scheme was not verified. Launch via `GitHubDesktop.exe` only.

4. **Postman `postman://` or collection-runner CLI flags.** No official protocol/CLI reference was verified. Launch via `postman.exe` only.

5. **Notion `notion://`** (replacing `https://` with `notion://` on a page URL). Widely blogged, but no official Notion documentation was found. Web URLs are included.

6. **Figma `figma://` / `figma://file/{key}`.** No official Figma Help documentation was found. Official `https://www.figma.com/file/{fileKey}` is included.

7. **ChatGPT prefill / `?q=` (or similar) query parameters.** Not officially documented. Open `https://chatgpt.com` only.

8. **Zoom desktop URI (`zoommtg://`, `zoomus://`).** Zoom’s Windows “launch the client from your app” developer page returned 404 in this review. The official https join URL is included instead.

9. **Cursor `cursor {folder}` / VS Code-compatible path CLI.** Official Cursor docs reviewed here cover prompt/command/rule deeplinks and do not document a folder-open CLI analogous to `code {path}`. Launch and prompt deeplink only.

10. **`ms-paint:`** — This URI is associated with **Paint 3D**, not classic Microsoft Paint. Classic Paint is `mspaint.exe`.

11. **Windows Calendar new-event / appointment parameters** (beyond launching the app). Not verified. Use Google Calendar’s official TEMPLATE URL for a prefilled event. `outlookcal:` launch only.

12. **Outlook command-line compose switches** (`/c ipm.note`, `/m`). A Microsoft support URL for Office command-line switches could not be fetched in this session (404 on one published link). Compose uses official `mailto:` instead.

13. **Office URI schemes with local filesystem paths.** Official schemes allow `http`/`https` document URIs only. Local files use `WINWORD.EXE` / `EXCEL.EXE` / `POWERPNT.EXE {path}`.

14. **Further Steam browser-protocol commands** (`steam://open/games`, `steam://install/{id}`, `steam://run/{id}` vs `rungameid`, store-by-appid, etc.). Valve’s protocol wiki was blocked by bot-protection; only IANA `steam:`, bare launch, Steam’s own `rungameid` shortcut form, and `steam://store` are included.

15. **Epic purchase / checkout / overlay URIs.** Would fall under pay. Omitted. Store product pages and the documented `action=launch` path are included (launch is treated as opening an installed app, `safe`).

16. **Slack `slack://share-file`.** Official, but it opens a share/post dialog. Omitted so Slack entries stay on open/navigate.

17. **Teams `msteams://l/chat/...` and `msteams://l/call/...` forms.** Officially supported as a protocol, but Microsoft tells developers to prefer `https://teams.microsoft.com/l/` unless they know the desktop client is present. The database uses https for chat/schedule/call and `msteams:` only to launch Teams.

18. **Snipping Tool `redirect-uri` / `LaunchUriForResultsAsync` capture callback.** Official, but Microsoft states unpackaged Win32 callers cannot receive the callback that way. Overlay can launch capture; it should not depend on a redirect.

19. **Photos `ms-photos:videoedit`.** Official, but it requires a `SharedStorageAccessManager` file token, which a voice command cannot mint by itself.

20. **`calculator:` URI.** Common in third-party URI lists; a current Microsoft Learn citation was not found. `calc.exe` is used instead.

21. **Amazon.com / other Amazon marketplaces, YouTube watch-by-id, Google Docs open-by-id, Drive folder-by-id, Slack `https://slack.com/app_redirect`.** Out of the requested set or not needed once a verified equivalent existed.

22. **Keyboard-shortcut actions (`keys`).** None were added. Verified URI/CLI/URL paths were preferred (for example Snipping Tool uses `ms-screenclip:` rather than Win+Shift+S).

---

## Counts (after validation)

See the validator output. At generation time: 49 apps, 129 actions, 1 confirm-risk action (`microsoft-teams` / `start-call`).
