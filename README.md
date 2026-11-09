# kiosko-plugin-github

Your Actions runs, the pull requests waiting for your review and your own.

A plugin for [Kiosko](https://github.com/kiosko-lcd/kiosko), the widget mosaic for small USB LCD panels.

![Actions runs](docs/actions.png)

## Install

In Kiosko, **Plugins → Install from npm** → `kiosko-plugin-github`, then restart Kiosko. Or from a terminal:

```sh
npm install --prefix ~/.config/kiosko/plugins kiosko-plugin-github
```

(macOS: `~/Library/Application Support/Kiosko/plugins`, Windows: `%APPDATA%\Kiosko\plugins`.)

## Requirements

- [`gh`](https://cli.github.com) logged in (`gh auth login`), or a token in the source options: fine-grained with read access to Actions, Pull requests and Metadata, or classic with `repo` and `read:org` (plus `notifications` for the unread count). GitHub Enterprise Server: set the host.

## Widgets

### Actions runs — `github/actions`

Recent GitHub Actions workflow runs: broken first, then running (with a timer) and queued, passing last.

![Actions runs](docs/actions.png)

Uses: `github/activity`.

| Option | Type | Default | |
|---|---|---|---|
| `latestOnly` | boolean | `true` | Only the latest run per workflow and branch |
| `branch` | string | `""` | Only this branch. Empty = every branch. |
| `aliases` | map | `{}` | Short repo names. Repo (name or owner/name) → what to show, e.g. web-frontend → web. |

### Pull requests — `github/reviews`

Pull requests waiting for your review (whose, how long they have waited, how their checks are doing), then your own with what blocks them: failing checks, changes requested, approved. Mentions last, if you want them.

![Pull requests](docs/reviews.png)

Uses: `github/activity`.

| Option | Type | Default | |
|---|---|---|---|
| `showMine` | boolean | `true` | Also my own pull requests |
| `showMentions` | boolean | `false` | Also mentions |
| `includeDrafts` | boolean | `false` | Include drafts |
| `aliases` | map | `{}` | Short repo names. Repo (name or owner/name) → what to show, e.g. web-frontend → web. |

### GitHub inbox — `github/inbox`

Three numbers: reviews waiting for you, failing runs and unread notifications. Coloured only when they ask for you.

![GitHub inbox](docs/inbox.png)

Uses: `github/activity`.

*No options.*

## Data sources

### GitHub activity — `github/activity`

Actions runs of your repos, your open pull requests and the ones you are asked to review, through a token or the gh CLI. Read every 2 min while a widget uses it. Options are set once in Kiosko → Settings → Data sources.

| Option | Type | Default | |
|---|---|---|---|
| `host` | string | `""` | GitHub host. Empty = github.com. A GitHub Enterprise Server host uses its /api/v3. |
| `token` | string | *(secret)* | Access token. Fine-grained token with read access to Actions, Pull requests and Metadata, or a classic one with repo and read:org (and notifications for the inbox count). Empty = use the gh CLI and its login. |
| `repos` | list | `[]` | Repositories for Actions. owner/repo. Empty = your 5 most recently pushed repos. |
| `runsPerRepo` | number | `10` | Runs read per repo |
| `mentions` | boolean | `true` | Also look for mentions |
| `bin` | string | `"gh"` | gh command |

## Development

```sh
npm install
npm test          # node:test
npm run check     # TypeScript
npm run build     # dist/index.js, what Kiosko loads
```

To try it in a running Kiosko without publishing: `kiosko plugins link .` and restart Kiosko.

Working on Kiosko and its plugins together: clone them side by side
(`kiosko/` and `kiosko-plugins/kiosko-plugin-github/`) and run `npm install` in
`kiosko/`; its workspaces link every plugin found in `../kiosko-plugins`.

## License

MIT
