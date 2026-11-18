# dsh-plugin-doctor

[![test](https://github.com/ginxiu0330-sketch/dsh-plugin-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/ginxiu0330-sketch/dsh-plugin-doctor/actions/workflows/test.yml)

DSH (DeepSeek Harness) is a local agent runtime built on the cordis microkernel. A *profile* is
the directory DSH boots from: a `package.json` listing plugin bundles, plus a `cordis.patch.yml`
that layers configuration over them. Bundles arrive through three channels at once — the npm
registry, local tarballs, and packages that ship with DSH itself — and nothing warns you when one
of them drifts out of range. Upgrades then fail late, after the profile is already half-broken.

This plugin reads that state and reports it. It is the check you run *before* touching anything.

One `plugin_doctor` call answers the four questions that actually break a working setup, without changing anything:

1. **Which plugins have newer versions, and which of those would break the running DSH?**
2. **Which installed package declares requirements this DSH version rejects?**
3. **What each bundle patches, and where two bundles claim the same row** — the overrides that make load order matter.
4. **Which skills are shadowed by a same-named copy from a higher-priority source?** — the usual reason "my edit did nothing".

It installs, removes, enables and patches nothing. `readOnly` in the report is always `true`.

```
> run plugin_doctor

# DSH plugin doctor — 2026-11-18 03:22 UTC

runtime unknown · 3 packages · 1 upgradable · 1 incompatible · 0 broken

Read-only: nothing was installed, removed, enabled or patched.

## 1. Installed packages

| package | installed | latest | status | channel | note |
| --- | --- | --- | --- | --- | --- |
| dsh-broken | 0.1.0 | — | INCOMPATIBLE | unknown (disabled) | incompatible-version: engines.dsh wants >=0.3.0 |
| dsh-cost-meter | 1.9.65 | 1.10.0 | update | registry |  |
| dsh-oil-ui | 0.3.1 | — | local | file | file spec |

## 2. DSH compatibility

| package | version | runtime | scope | requirements |
| --- | --- | --- | --- | --- |
| dsh-broken | 0.1.0 | 0.2.2-rc.2 | installed | engines.dsh: >=0.3.0 |

## 3. Patch health

| bundle | rows | overrides | state | problems |
| --- | --- | --- | --- | --- |
| dsh-oil-ui | 1 | 1 | enabled |  |

1 row(s) override rows the bundle does not declare. Those are the rows most likely to
break silently when a bundle upgrades, because the override keeps pointing at an id the
new version may have renamed or dropped.

## 4. Skills

| skill | source | invocation | state | path |
| --- | --- | --- | --- | --- |
| oil-ui | project-dsh | model | active | /p/.dsh/skills/oil-ui |
| oil-ui | user-dsh | model | shadowed by project-dsh | /u/skills/oil-ui |
```

## Why a separate plugin

The built-in plugin manager answers *"is this one package installed and enabled?"*. It does not answer *"what will hurt me at the next upgrade?"*. Those are different questions, and the second one needs the registry, the manifest requirements, the patch graph and the skill catalog in one view. This plugin only reads; the official manager remains the thing that changes your profile.

## Install

The plugin is a bundle: an npm package plus a `cordis.patch.yml` that inserts one row.

**From GitHub** — not on npm yet, so start from a checkout:

```bash
git clone https://github.com/ginxiu0330-sketch/dsh-plugin-doctor
```

**From the GUI** — Settings → Plugins → install from local path, and point it at that checkout.

**Manually** — in your profile (`%USERPROFILE%\.dsh\profiles\<name>` by default):

```jsonc
// package.json
{
  "dependencies": {
    "dsh-plugin-doctor": "file:C:/path/to/dsh-plugin-doctor"
  }
}
```

```yaml
# cordis.patch.yml — append one array entry
- insert:
    - id: plugin-doctor
      name: 'dsh-plugin-doctor'
```

Then install with the launcher's package manager and restart DSH. The desktop host cannot hot-apply a new bundle, so the first load always needs a restart.

## Tool

`plugin_doctor` — read-only.

| parameter | type | default | meaning |
| --- | --- | --- | --- |
| `checkUpdates` | boolean | `true` | Ask the registry which packages have newer versions. One round trip per registry spec; disable for a fast offline report. |
| `checkSkills` | boolean | `true` | Include the skill catalog and flag shadowed names. |
| `timeoutMs` | integer | `20000` | Time budget per package for the registry check. A timeout becomes `unknown`, never an error. |

The tool never throws on a missing service: a profile without a plugin manager or skill catalog still produces a report with `pluginManagerError` / `skillsError` set.

### Status values

| status | meaning |
| --- | --- |
| `update` | A registry dependency; the registry answered with a newer version. |
| `incompatible` | The installed package, or the candidate upgrade, declares requirements this DSH version rejects. |
| `error` | The plugin manager could not read or resolve the package (`unexpected-package`, `not-bundle`, missing files). |
| `local` | No upgrade channel: a `file:` spec, a git pin, or a bundle that ships with DSH. |
| `ok` | Registry dependency at the newest version, or a shipped bundle. |
| `unknown` | The registry could not be asked (offline, timeout, not found). Never silently treated as `ok`. |

## What it uses

Only public host APIs, all declared through `inject = ['tools', 'pluginManager', 'skills']`:

- `ctx.pluginManager.listBundles()` — installed packages, versions, patch rows and overrides.
- `ctx.pluginManager.listVersions(name)` — newer published versions, including whether the candidate declares `dsh.bundle` and whether it rejects the running DSH.
- `ctx.skills.list()` — the skill catalog with sources and paths.
- `@deepseek-ai/dsh-tools` `defineTool` for the schema, the executor and the renderer.

No file is read or written by this plugin; the profile stays the host's business.

## Roadmap

- **0.2** — `plugin_upgrade` with `dryRun: true` as the default: snapshot `package.json` / `cordis.patch.yml`, upgrade one package at a time, report every `ChangeResult.application`, and print the exact rollback command. The desktop host forces `allowRestart: false`, so "upgrade" here always means *upgrade, then tell the user to restart* — never a bare Electron relaunch.
- **0.2** — publish to npm so the install is one line instead of a clone plus a `file:` dependency.
- **0.3** — read the profile's own `cordis.patch.yml` (via `ctx.profileContext`) to flag overrides whose target id no loaded bundle declares, and stale `.bak` backups left by hand edits.
- **0.3** — skill provenance: git remote plus a content hash per skill, since the catalog exposes no version.
- Deliberately out of scope: a client UI panel, unattended upgrades, `dsh.client` injection.

## Development

```bash
npm test   # fake host: classification, shadowing, rendering, degradation
```

Zero build step — the source is the shipped artifact. `@deepseek-ai/*` arrive from the host at load time, so they are `peerDependencies` and never installed into the profile.

## License

MIT
